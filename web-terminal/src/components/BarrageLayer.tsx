import { useEffect, useRef, useState } from 'react'
import './BarrageLayer.css'

type BarrageItem = {
    id: number
    text: string
    top: number
    duration: number
    color: string
    isSpecial?: boolean
}

const COLORS = ['#0f0', '#0ff', '#f0f', '#ff0', '#fff', '#ffa500']

// 趣味语录库
const FUN_QUOTES = [
    "听说隔壁老王又偷到了金瓜...",
    "今天天气不错，适合去好友家'串门'",
    "农场主只有两种：还没被偷的，和已经被偷光的",
    "只要锄头挥得好，没有墙角挖不倒",
    "记得给作物浇水，不然它们会渴死的",
    "半夜收菜身体好，通宵偷菜精神足",
    "那个带红领巾的稻草人好像在看我...",
    "小心！警察正在巡逻...",
    "据统计，99%的农场主都有过“顺手牵羊”的经历",
    "这届虫子太难抓了，建议直接喷药",
    "施肥还是不施肥，这是一个问题",
    "听说集齐七颗龙珠可以召唤神龙...哦不对是七种作物",
    "为什么我的菜总是比别人的慢熟？",
    "想要富，先修路...不对，先种树！",
]

// 关键词过滤（只显示这些有趣的）
const INTERESTING_KEYWORDS = ['偷', '升级', '获得', '购买', '激活', '扩容', '大奖', '稀有']
// 屏蔽词（太频繁的）
const IGNORE_KEYWORDS = ['扫描', '检测', '进入', '离开', '查询', '失败', '跳过']

export function BarrageLayer({ logs }: { logs: { message: string, tag: string }[] }) {
    const [items, setItems] = useState<BarrageItem[]>([])
    const lastLogLen = useRef(logs.length)
    const nextId = useRef(1)

    // 定时生成趣味语录
    useEffect(() => {
        const timer = setInterval(() => {
            if (document.hidden) return // 页面隐藏时不生成

            const text = FUN_QUOTES[Math.floor(Math.random() * FUN_QUOTES.length)]
            const newItem: BarrageItem = {
                id: nextId.current++,
                text: `[趣闻] ${text}`,
                top: Math.random() * 80 + 10,
                duration: Math.random() * 20 + 50, // 50-70s (极慢)
                color: '#fff', // 白色
                isSpecial: false
            }
            setItems(prev => [...prev, newItem])
        }, 15000)
        return () => clearInterval(timer)
    }, [])

    useEffect(() => {
        // Only process new logs
        if (logs.length > lastLogLen.current) {
            const newLogs = logs.slice(lastLogLen.current)
            const newItems: BarrageItem[] = []

            for (const log of newLogs) {
                // 1. 必须包含有趣关键词
                if (!INTERESTING_KEYWORDS.some(k => log.message.includes(k))) continue
                // 2. 不能包含屏蔽词
                if (IGNORE_KEYWORDS.some(k => log.message.includes(k))) continue

                const isSteal = log.message.includes('偷')
                const isLevelUp = log.message.includes('升级')

                newItems.push({
                    id: nextId.current++,
                    text: `[${log.tag}] ${log.message}`,
                    top: Math.random() * 80 + 10,
                    duration: Math.random() * 20 + 40, // 40-60s
                    color: isSteal ? '#ff4444' : (isLevelUp ? '#ffff00' : COLORS[Math.floor(Math.random() * COLORS.length)]),
                    isSpecial: isSteal || isLevelUp
                })
            }

            if (newItems.length > 0) {
                setItems(prev => [...prev, ...newItems])
            }
        }
        lastLogLen.current = logs.length
    }, [logs])

    const handleAnimationEnd = (id: number) => {
        setItems(prev => prev.filter(item => item.id !== id))
    }

    return (
        <div className="barrage-container">
            {items.map(item => (
                <div
                    key={item.id}
                    className={`barrage-item ${item.isSpecial ? 'special' : ''}`}
                    style={{
                        top: `${item.top}%`,
                        animationDuration: `${item.duration}s`,
                        color: item.color,
                        fontSize: item.isSpecial ? '1.2em' : '1em',
                        textShadow: item.isSpecial ? '0 0 5px rgba(0,0,0,0.8)' : 'none',
                        zIndex: item.isSpecial ? 10 : 1
                    }}
                    onAnimationEnd={() => handleAnimationEnd(item.id)}
                >
                    {item.text}
                </div>
            ))}
        </div>
    )
}
