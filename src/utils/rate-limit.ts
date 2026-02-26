
type RateLimitEntry = {
    count: number
    firstAttempt: number
}

const STORAGE = new Map<string, RateLimitEntry>()

// Clean up old entries every 10 minutes
setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of STORAGE.entries()) {
        if (now - entry.firstAttempt > 3600_000) { // Keep explicitly for 1 hour to be safe? Or just TTL?
            // Actually, we just need to adhere to the window.
            // If window is 60s, and firstAttempt was > 60s ago, it's expired.
            // But we might want to keep "blocked" state longer?
            // For now, simple cleanup of really old stuff (e.g. > 1 hour)
            if (now - entry.firstAttempt > 3600000) STORAGE.delete(key)
        }
    }
}, 600000)

/**
 * Check if an IP is rate limited.
 * @param ip The identifier (IP address)
 * @param limit Max attempts allowed in the window
 * @param windowMs Time window in milliseconds
 * @returns { limitReached: boolean, remaining: number, resetTime: number }
 */
export function checkRateLimit(ip: string, limit: number = 5, windowMs: number = 60000, increment: boolean = true) {
    const now = Date.now()
    const entry = STORAGE.get(ip)

    if (!entry) {
        if (increment) {
            STORAGE.set(ip, { count: 1, firstAttempt: now })
            return { limitReached: false, remaining: limit - 1, resetTime: now + windowMs }
        } else {
            return { limitReached: false, remaining: limit, resetTime: now + windowMs }
        }
    }

    // Check if window has passed
    if (now - entry.firstAttempt > windowMs) {
        if (increment) {
            entry.count = 1
            entry.firstAttempt = now
            return { limitReached: false, remaining: limit - 1, resetTime: now + windowMs }
        } else {
            // Reset logically but don't start new window until first increment? 
            // Or just treat as fresh window.
            // If we don't increment, we shouldn't really modify the entry unless we want to reset the timer?
            // Let's just say if window passed, count is effectively 0.
            return { limitReached: false, remaining: limit, resetTime: now + windowMs }
        }
    }

    // Within window
    if (entry.count >= limit) {
        return {
            limitReached: true,
            remaining: 0,
            resetTime: entry.firstAttempt + windowMs
        }
    }

    if (increment) {
        entry.count++
        return {
            limitReached: false,
            remaining: limit - entry.count,
            resetTime: entry.firstAttempt + windowMs
        }
    } else {
        return {
            limitReached: false,
            remaining: limit - entry.count,
            resetTime: entry.firstAttempt + windowMs
        }
    }
}

export function incrementRateLimit(ip: string, limit: number = 5, windowMs: number = 60000) {
    return checkRateLimit(ip, limit, windowMs, true)
}

/**
 * Artificial delay to slow down brute force
 */
export async function randomDelay(min = 500, max = 1500) {
    const ms = Math.min(max, Math.max(min, Math.floor(Math.random() * (max - min) + min)))
    await new Promise(resolve => setTimeout(resolve, ms))
}
