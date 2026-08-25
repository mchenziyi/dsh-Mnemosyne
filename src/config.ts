import z from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  projectRoot?: string
  autoCapture?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  projectRoot: z.string(),
  autoCapture: z.boolean().default(true),
})
