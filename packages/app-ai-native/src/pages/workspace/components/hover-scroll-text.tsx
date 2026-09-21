import { createSignal, onCleanup, onMount } from "solid-js"

const fade = "linear-gradient(to right, transparent, black 8px, black calc(100% - 8px), transparent)"
const speed = 35
const dwell = 300

function reduced() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function HoverScrollText(props: { text: string }) {
  let el: HTMLSpanElement | undefined
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const [moving, setMoving] = createSignal(false)

  const cancelFrame = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  const cancelTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const stop = () => {
    cancelTimer()
    cancelFrame()
    setMoving(false)
    if (el) el.scrollLeft = 0
  }

  const run = () => {
    if (!el) return
    const target = el.scrollWidth - el.clientWidth
    if (target <= 1) return
    setMoving(true)
    if (reduced()) {
      el.scrollLeft = target
      return
    }

    const started = performance.now()
    const duration = (target / speed) * 1000
    const step = () => {
      if (!el) return
      const progress = Math.min(1, (performance.now() - started) / duration)
      el.scrollLeft = target * progress
      frame = progress < 1 ? requestAnimationFrame(step) : undefined
    }
    frame = requestAnimationFrame(step)
  }

  const start = () => {
    cancelTimer()
    if (!el || el.scrollWidth - el.clientWidth <= 1) return
    timer = setTimeout(() => {
      timer = undefined
      cancelFrame()
      run()
    }, dwell)
  }

  onMount(() => {
    if (!el) return
    const row = el.closest("[data-session-row]") ?? el
    row.addEventListener("pointerenter", start)
    row.addEventListener("pointerleave", stop)
    onCleanup(() => {
      row.removeEventListener("pointerenter", start)
      row.removeEventListener("pointerleave", stop)
    })
  })

  onCleanup(() => {
    cancelTimer()
    cancelFrame()
  })

  return (
    <span
      ref={(node) => (el = node)}
      data-scrolling={moving() ? "true" : undefined}
      class="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      classList={{ "text-clip": moving(), "text-ellipsis": !moving() }}
      style={moving() ? { "mask-image": fade, "-webkit-mask-image": fade } : undefined}
    >
      {props.text}
    </span>
  )
}
