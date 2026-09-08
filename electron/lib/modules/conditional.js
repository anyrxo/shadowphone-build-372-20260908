// electron/lib/modules/conditional.js
// ── Handler: conditional ────────────────────────────────────────────
// Evaluates a condition and returns should_proceed true/false.
// Supported condition_type values: 'time_range', 'day_of_week', 'battery_above', 'random_chance'.

module.exports = async (device, config) => {
    try {
        const condition_type = config.condition_type || 'random_chance'
        let should_proceed = false
        let reason = ''

        if (condition_type === 'time_range') {
            const time_start = config.time_start
            const time_end = config.time_end
            if (time_start && time_end) {
                const now = new Date()
                const [startHour, startMin] = time_start.split(':').map(Number)
                const [endHour, endMin] = time_end.split(':').map(Number)
                const currentTime = now.getHours() * 60 + now.getMinutes()
                const startTime = startHour * 60 + startMin
                const endTime = endHour * 60 + endMin
                should_proceed = currentTime >= startTime && currentTime <= endTime
                reason = `Current time ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} is ${should_proceed ? 'within' : 'outside'} ${time_start}-${time_end}`
            }
        } else if (condition_type === 'day_of_week') {
            const days = config.days || []
            const today = new Date().getDay()
            should_proceed = days.includes(today)
            reason = `Today is day ${today}, allowed days: ${days.join(',')}`
        } else if (condition_type === 'battery_above') {
            const threshold = config.threshold ?? 50
            const batteryOutput = device.shell('dumpsys battery | grep level')
            const match = batteryOutput.match(/level:\s*(\d+)/)
            const level = match ? parseInt(match[1]) : 0
            should_proceed = level >= threshold
            reason = `Battery ${level}% is ${should_proceed ? 'above' : 'below'} ${threshold}%`
        } else if (condition_type === 'random_chance') {
            const chance = config.random_chance ?? config.chance ?? 50
            should_proceed = Math.random() * 100 < chance
            reason = `Random ${chance}% chance: ${should_proceed ? 'PROCEED' : 'SKIP'}`
        }

        return { success: true, data: { should_proceed, condition_type, reason } }
    } catch (error) {
        return { success: false, error: error.message }
    }
}
