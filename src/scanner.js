import {dirname, join} from 'path'
import {Octokit} from '@octokit/core'
import {enterpriseCloud} from '@octokit/plugin-enterprise-cloud'
import {fileURLToPath} from 'url'
import {readFileSync} from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MyOctokit = Octokit.plugin(enterpriseCloud)
const SUPPORTED_LANGS = ['go', 'javascript', 'csharp', 'python', 'cpp', 'java']

class ActionScanner {
  /**
   * @param {object} options
   * @param {string} options.token GitHub Personal Access Token
   * @param {string} options.enterprise GitHub Enterprise Cloud slug
   * @param {string} options.organization GitHub organization slug
   */
  constructor({token, enterprise, organization}) {
    if (!token) {
      throw new Error('`token` is required')
    }
    this.octokit = new MyOctokit({auth: token})
    if (!enterprise && !organization) {
      throw new Error('`enterprise` and `organization` are required')
    }
    this.enterprise = enterprise
    this.organization = organization
  }
  /**
   * @async
   * @function deleteFork
   */
  async deleteFork({owner, repo}) {
    const {octokit} = this
    try {
      // https://docs.github.com/en/rest/reference/repos#delete-a-repository
      await octokit.request('DELETE /repos/{owner}/{repo}', {
        owner,
        repo
      })
    } catch (error) {
      octokit.log.error(error.message, error)
      // do nothing
    }
    // wait 5 seconds
    await this.wait(5000)
  }
  /**
   * @async
   * @function createFork
   */
  async createFork({owner, repo}) {
    const {octokit, organization} = this
    try {
      // https://docs.github.com/en/rest/reference/repos#create-a-fork
      const {data} = await octokit.request('POST /repos/{owner}/{repo}/forks', {
        owner,
        repo,
        organization
      })
      this.owner = data.owner.login
      this.repo = data.name
      this.ref = data.parent.default_branch

      const language = data.parent.language || undefined
      this.language = language === 'TypeScript' ? 'javascript' : language
    } catch (error) {
      throw error
    }
    // sleep 10 seconds for async forking
    await this.wait(10000)
  }
  /**
   * @async
   * @function addCodeQLWorkflow
   * @returns {void}
   */
  async deleteExistingWorkflows() {
    const {octokit, owner, repo, ref} = this
    try {
      // https://docs.github.com/en/rest/reference/git#get-a-reference
      const {
        data: {
          object: {sha}
        }
      } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner,
        repo,
        ref: `heads/${ref}`
      })
      // https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch
      const {
        createCommitOnBranch: {
          commit: {oid}
        }
      } = await octokit.graphql(
        `mutation (
      $nwo: String!,
      $branch: String!,
      $oid: GitObjectID!
    ) {
      createCommitOnBranch(input: {
        branch: { repositoryNameWithOwner: $nwo, branchName: $branch },
        expectedHeadOid: $oid,
        message: { headline: "🤖 Delete existing workflows" },
        fileChanges: {
          deletions: [{ path: ".github/workflows" }]
        }
      }) {
        commit { url,  oid }
      }
    }`,
        {
          nwo: `${owner}/${repo}`,
          branch: ref,
          oid: sha
        }
      )
      this.oid = oid || sha
    } catch (error) {
      throw error
    }
  }
  /**
   * @async
   * @function addCodeQLWorkflow
   * @returns {void}
   */
  async addCodeQLWorkflow() {
    const {octokit, owner, oid, repo, ref, language} = this
    try {
      const workflowTpl = 'codeql-template.tmpl'
      const workflowBuffer = readFileSync(join(__dirname, workflowTpl), 'utf8')
      const _content = workflowBuffer.toString('base64')
      const workflowContent = _content.replace(
        `
          languages: __languages__`,
        language && SUPPORTED_LANGS.includes(language)
          ? `
          languages: ${language}`
          : ''
      )
      const configTpl = 'codeql-config.tmpl'
      const configContent = readFileSync(join(__dirname, configTpl), 'utf8')

      this.path = '.github/workflows/codeql-scanner.yml'

      // https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch
      await octokit.graphql(
        `mutation (
          $nwo: String!,
          $branch: String!,
          $oid: GitObjectID!,
          $workflow: Base64String!,
          $workflowPath: String!,
          $config: Base64String!
        ) {
          createCommitOnBranch(input: {
            branch: { repositoryNameWithOwner: $nwo, branchName: $branch },
            expectedHeadOid: $oid,
            message: { headline: "🤖 Add GitHub Action OSS scanner" },
            fileChanges: {
              additions: [{
                path: $workflowPath, contents: $workflow
              }, {
                path: ".github/config/codeql-config.yml", contents: $config
              }]
            }
          }) {
            commit { url, oid }
          }
        }`,
        {
          nwo: `${owner}/${repo}`,
          branch: ref,
          oid,
          workflow: Buffer.from(workflowContent, 'utf-8').toString('base64'),
          workflowPath: this.path,
          config: Buffer.from(configContent, 'utf-8').toString('base64')
        }
      )

      // wait 5 seconds
      await this.wait(5000)
    } catch (error) {
      throw error
    }
  }
  /**
   * @async
   * @function triggerScans
   * @throws
   */
  async triggerScans() {
    const {octokit, owner, repo, path, ref} = this
    try {
      // https://docs.github.com/en/rest/reference/actions#create-a-workflow-dispatch-event
      await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
        owner,
        repo,
        workflow_id: path,
        ref
      })
      // wait for the dispatch event to trigger
      await this.wait(5000)
      // https://docs.github.com/en/rest/reference/actions#list-workflow-runs-for-a-repository
      const {
        data: {workflow_runs}
      } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
        owner,
        repo,
        event: 'workflow_dispatch'
      })
      let run_id = 0
      for (const wfr of workflow_runs) {
        if (wfr.name === 'CodeQL OSS Scanner') run_id = wfr.id
      }
      // wait for the scanner to finish
      if (run_id > 0) await this.waitForScan(run_id)
    } catch (error) {
      throw error
    }
  }
  /**
   * @async
   * @function waitForScan
   * @param {number} run_id
   */
  async waitForScan(run_id) {
    const {octokit, owner, repo} = this
    // https://docs.github.com/en/rest/reference/actions#get-a-workflow-run
    const {
      data: {name, status, conclusion, html_url}
    } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
      owner,
      repo,
      run_id
    })
    if (status !== 'completed') {
      await this.wait(60000)
      await this.waitForScan(run_id)
    } else {
      if (conclusion !== 'success' && conclusion !== null) {
        throw new Error(`${name} concluded with status ${conclusion} (${html_url}).`)
      }
    }
  }
  /**
   * @async
   * @function listCodeScanningAlerts
   */
  async listCodeScanningAlerts() {
    const {octokit, owner, repo} = this
    let alerts = []
    try {
      // https://docs.github.com/en/rest/reference/code-scanning#list-code-scanning-alerts-for-a-repository
      const {data} = await octokit.request('GET /repos/{owner}/{repo}/code-scanning/alerts', {
        owner,
        repo
      })
      alerts = data
    } catch (error) {
      octokit.log.error(error.message, error)
      // do nothing
    }
    return alerts
  }
  /**
   * @async
   * @function listCodeScanningAnalyses
   */
  async listCodeScanningAnalyses() {
    const {octokit, owner, repo} = this
    let analyses = []
    try {
      // https://docs.github.com/en/rest/reference/code-scanning#list-code-scanning-analyses-for-a-repository
      const {data} = await octokit.request('GET /repos/{owner}/{repo}/code-scanning/analyses', {
        owner,
        repo
      })
      analyses = data
    } catch (error) {
      octokit.log.error(error.message, error)
      // do nothing
    }
    return analyses
  }
  /**
   * @param {number} milliseconds
   * @returns {Promise}
   * @throws {Error}
   */
  wait(milliseconds) {
    return new Promise(_resolve => {
      if (typeof milliseconds !== 'number') {
        throw new Error('milliseconds not a number')
      }
      setTimeout(() => _resolve('done!'), milliseconds)
    })
  }
}

export default ActionScanner
