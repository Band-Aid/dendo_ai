import { readAdminState } from '~/server/utils/adminStore'
import { spawn } from 'child_process'
import { resolve } from 'path'

interface AggregationRequest {
  dsl?: string
  body?: any
  format?: 'dsl' | 'json'
}

export default defineEventHandler(async (event) => {
  const input = await readBody<AggregationRequest>(event)
  const orgId = event.context.orgId as string
  const adminState = await readAdminState(orgId)
  const { integrationKey, apiEndpoint, defaultAppId } = adminState.pendo

  if (!integrationKey) {
    throw createError({
      statusCode: 400,
      message: 'Pendo integration key not configured. Please set it in Admin settings.'
    })
  }

  try {
    // Determine what to pass to Python
    let inputText: string
    let format: string

    if (input.dsl) {
      inputText = input.dsl
      format = 'dsl'
    } else if (input.body) {
      inputText = JSON.stringify(input.body)
      format = 'json'
    } else {
      throw createError({
        statusCode: 400,
        message: 'Either dsl or body must be provided'
      })
    }

    // Path to Python module
    const projectRoot = resolve(process.cwd(), '../..')
    const srcPath = resolve(projectRoot, 'src')
    
    // Build env vars
    const env = {
      ...process.env,
      PENDO_INTEGRATION_KEY: integrationKey,
      PENDO_AGG_URL: apiEndpoint || 'https://app.pendo.io/api/v1/aggregation',
      PYTHONPATH: `${srcPath}:${projectRoot}${process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : ''}`
    }

    // Spawn Python process
    const pythonProcess = spawn(
      'python3',
      ['-m', 'tools.pendo.run_agg', '--stdin', '--format', format, '--pretty'],
      {
        cwd: projectRoot,
        env
      }
    )

    let stdout = ''
    let stderr = ''

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    // Write input to stdin
    pythonProcess.stdin.write(inputText)
    pythonProcess.stdin.end()

    // Wait for process to complete
    const exitCode = await new Promise<number>((resolve) => {
      pythonProcess.on('close', (code) => {
        resolve(code || 0)
      })
    })

    if (exitCode !== 0) {
      console.error('Python aggregation failed:', stderr)
      throw createError({
        statusCode: 500,
        message: `Aggregation failed: ${stderr || 'Unknown error'}`
      })
    }

    // Parse result
    try {
      const result = JSON.parse(stdout)
      return {
        success: true,
        data: result,
        metadata: {
          format,
          appId: defaultAppId
        }
      }
    } catch (err) {
      console.error('Failed to parse Python output:', stdout)
      throw createError({
        statusCode: 500,
        message: 'Failed to parse aggregation results'
      })
    }
  } catch (error: any) {
    console.error('Aggregation error:', error)
    throw createError({
      statusCode: error.statusCode || 500,
      message: error.message || 'Failed to run aggregation'
    })
  }
})
