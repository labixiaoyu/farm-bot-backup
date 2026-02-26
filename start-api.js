import { config } from './src/config/index.js'
import { loadProto } from './src/protocol/proto-loader.js'
import { startApiServer } from './src/api/server.js'

async function start() {
  try {
    // 加载protobuf类型定义
    await loadProto()
    console.log('Proto 加载成功')
    
    // 启动API服务器
    startApiServer(config.apiPort)
    
    // When API is enabled, run as a pure API service without interactive UI
    console.log('API服务已启动，运行中...')
    console.log('按 Ctrl+C 退出')
    
    // Keep process running
    await new Promise(() => {
      process.on('SIGINT', () => {
        console.log('正在退出...')
        process.exit(0)
      })
    })
  } catch (error) {
    console.error('启动API服务器失败:', error)
    process.exit(1)
  }
}

start()
