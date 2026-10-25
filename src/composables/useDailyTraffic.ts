import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { computed, ref, toValue, watch } from 'vue'

interface DailyTrafficSample {
  /** 上次采样的本地时间戳（毫秒） */
  t: number
  /** 上次采样时的上行速率（字节/秒） */
  u: number
  /** 上次采样时的下行速率（字节/秒） */
  d: number
}

interface DailyTrafficRecord {
  date: string
  up: number
  down: number
  last: Record<string, DailyTrafficSample>
}

const STORAGE_KEY = 'emerald:daily-traffic:v1'
/** 相邻两次采样允许的最大间隔；页面休眠或掉采样超过该值时丢弃该段，避免用过期速率外推 */
const MAX_SAMPLE_GAP_MS = 60_000

function getLocalDate(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function createRecord(): DailyTrafficRecord {
  return { date: getLocalDate(), up: 0, down: 0, last: {} }
}

function loadRecord(): DailyTrafficRecord {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return createRecord()
    const parsed = JSON.parse(raw) as Partial<DailyTrafficRecord>
    if (
      typeof parsed.date === 'string'
      && typeof parsed.up === 'number' && Number.isFinite(parsed.up) && parsed.up >= 0
      && typeof parsed.down === 'number' && Number.isFinite(parsed.down) && parsed.down >= 0
      && parsed.last !== null && typeof parsed.last === 'object'
    ) {
      return {
        date: parsed.date,
        up: parsed.up,
        down: parsed.down,
        // 休眠前的采样时间戳已过期，积分时会因间隔过大被丢弃，无需在此清理
        last: parsed.last,
      }
    }
  }
  catch {
    // 本地记录损坏时丢弃重算，不影响页面其余功能
  }
  return createRecord()
}

function saveRecord(record: DailyTrafficRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  }
  catch {
    // 隐私模式等存储不可用场景下只在内存中累计
  }
}

function finiteSpeed(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// API 不提供按日流量统计，实时推送也只有速率字段，因此今日流量只能在浏览器内
// 按「速率 × 时间间隔」积分估算：只统计页面打开期间的流量，属近似值而非计量值。
export function useDailyTraffic(nodes: MaybeRefOrGetter<NodeData[]>) {
  const record = ref<DailyTrafficRecord>(loadRecord())

  // store 更新状态时是原地替换数组元素、不更换数组引用，直接 watch 数组引用不会触发；
  // 这里对「节点 + 实时速率」签名做侦听，速率每次刷新变化后才进入积分。
  const speedSignature = computed(() => toValue(nodes)
    .map(node => `${node.uuid}:${node.net_out || 0}:${node.net_in || 0}`)
    .join('|'))

  watch(
    speedSignature,
    () => {
      const list = toValue(nodes)
      const now = Date.now()
      const today = getLocalDate()
      const base = record.value.date === today
        ? record.value
        : { ...createRecord(), last: record.value.last }

      let { up, down } = base
      const last: Record<string, DailyTrafficSample> = {}
      for (const node of list) {
        const previous = base.last[node.uuid]
        // 首次见到该节点（或跨天清零后）只记录基线，不积分
        if (previous) {
          const elapsedMs = now - previous.t
          if (elapsedMs > 0 && elapsedMs <= MAX_SAMPLE_GAP_MS) {
            const seconds = elapsedMs / 1000
            up += finiteSpeed(node.net_out) * seconds
            down += finiteSpeed(node.net_in) * seconds
          }
        }
        // 只保留当前列表内的节点：切换分组后消失的节点不占存储
        last[node.uuid] = { t: now, u: finiteSpeed(node.net_out), d: finiteSpeed(node.net_in) }
      }

      const next = { date: today, up, down, last }
      record.value = next
      saveRecord(next)
    },
    { immediate: true },
  )

  return {
    dailyUp: computed(() => record.value.up),
    dailyDown: computed(() => record.value.down),
  }
}
