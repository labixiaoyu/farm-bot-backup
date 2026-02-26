
export const ERROR_MAP: Record<string, string> = {
    'ETIMEDOUT': '连接超时，请检查网络或代理设置',
    'ECONNREFUSED': '连接被拒绝，服务器可能未启动',
    'ECONNRESET': '连接被重置，可能是网络波动',
    'EHOSTUNREACH': '无法访问主机，请检查网络',
    'ENOTFOUND': '无法解析域名，请检查DNS或代理',
    'ws connection failed': 'WebSocket连接失败',
    'socket hang up': '连接意外断开',
    'network timeout': '网络请求超时',
    'Request failed with status code 403': '请求被拒绝 (403)，可能是IP被封禁',
    'Request failed with status code 404': '请求的资源不存在 (404)',
    'Request failed with status code 500': '服务器内部错误 (500)',
    'Card Disabled by Admin': '您的卡密已被管理员禁用',
    'Card Expired': '您的卡密已过期',
    'No valid card found': '未找到有效的卡密绑定',
    '二维码已失效': '二维码已过期，请刷新重试',
    '扫码超时': '扫码超时，请刷新重试',
    '获取QQ扫码登录码失败': '无法获取二维码，请稍后重试',
}

export const ERROR_KEYWORDS: Record<string, string> = {
    'timeout': '请求超时，请检查网络',
    'proxy': '代理连接失败，请检查代理配置',
    'socks5': 'SOCKS5代理连接失败',
    'tls': 'TLS握手失败，可能是网络问题',
    'handshake': '握手失败，可能是网络不稳定',
    'reset': '连接重置，请重试',
    'closed': '连接已关闭',
    'refused': '连接被拒绝',
}

export function mapLoginError(err: any): string {
    const msg = String(err?.message || err || '未知错误')

    // 1. Exact match
    if (ERROR_MAP[msg]) return ERROR_MAP[msg]

    // 2. Keyword match (case insensitive)
    const lower = msg.toLowerCase()
    for (const [key, val] of Object.entries(ERROR_KEYWORDS)) {
        if (lower.includes(key.toLowerCase())) {
            return `${val} (${msg})`
        }
    }

    // 3. Passthrough if Chinese (likely already friendly)
    if (/[\u4e00-\u9fa5]/.test(msg)) return msg

    return `登录失败: ${msg}`
}
