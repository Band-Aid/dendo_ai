import { useOrg } from './useOrg'

export interface ApiFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

export function useApi() {
  const { currentOrgId } = useOrg()

  const callApi = async <T = any>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        'X-Org-Id': currentOrgId.value,
        ...options.headers
      },
      ...options
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`API Error (${response.status}): ${errorText}`)
    }

    return response.json()
  }

  const apiFetch = async <T = any>(path: string, options: ApiFetchOptions = {}): Promise<T> => {
    const { body, headers = {}, method = 'GET' } = options
    return callApi<T>(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  }

  return { callApi, apiFetch }
}
