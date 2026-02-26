import { log } from '../utils/logger.js'
import { handleRequest } from './routes.js'
import http from 'node:http'
import { URL } from 'node:url'

let server: http.Server | null = null

export function startApiServer(port: number): void {
  if (server) return

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      const request = new Request(url.href, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? (await readBody(req)) as unknown as BodyInit : undefined,
      })

      const response = await handleRequest(request)

      res.statusCode = response.status
      res.statusMessage = response.statusText

      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      const body = await response.arrayBuffer()
      res.end(Buffer.from(body))
    } catch (error) {
      log('API', `处理请求失败: ${error}`)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: '内部服务器错误' }))
    }
  })

  server.listen(port, () => {
    log('API', `HTTP 服务已启动: http://localhost:${port}  Swagger: http://localhost:${port}/swagger`)
  })
}

export function stopApiServer(): void {
  if (server) {
    server.close()
    server = null
    log('API', 'HTTP 服务已停止')
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
