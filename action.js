import {endGroup, error, getInput, info, setFailed, setOutput, startGroup} from '@actions/core'
import ActionScanner from './src/scanner'

// action
;(async () => {
  try {
    const token = getInput('token')
    // FIXME
    const enterprise = getInput('enterprise')
    const organization = getInput('organization')
    const [owner, repo] = getInput('repository').split('/')

    const scanner = new ActionScanner({token, enterprise, organization})

    // make sure existing fork gets deleted
    await scanner.deleteFork({owner: organization, repo})

    // for the OSS repo
    await scanner.createFork({owner, repo})

    // delete existing workglows
    await scanner.deleteExistingWorkflows()

    // setup own CodeQL workflow
    await scanner.addCodeQLWorkflow()

    await scanner.triggerScans()
    const alerts = await scanner.listCodeScanningAlerts()

    info(`GitHub Actions OSS scanner ran for ${organization}/${repo}`)

    startGroup(`GitHub Actions OSS scanner found ${alerts.length} alerts`)
    for (const {number, html_url} of alerts) {
      info(`alert-${number}: ${html_url}`)
    }
    endGroup()

    setOutput('oss-scanner-result', JSON.stringify(alerts, null, 2))
  } catch (err) {
    error(err)
    setFailed(err.message)
  }
})()
