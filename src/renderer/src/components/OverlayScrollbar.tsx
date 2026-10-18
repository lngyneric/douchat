import { useEffect, useRef } from 'react'
import type { ReactElement, RefObject } from 'react'

const MIN_THUMB = 28
const HIDE_AFTER = 800

/**
 * A thin thumb drawn over the edge of a scroller whose native scrollbar is
 * hidden, so rows run the full width and the bar only appears while the list
 * is actually scrolling, the way macOS overlay scrollbars behave.
 *
 * Render it as a sibling of the scroller: both then share an offset parent,
 * which must be positioned.
 */
export function OverlayScrollbar({ target }: { target: RefObject<HTMLElement | null> }): ReactElement {
  const thumb = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scroller = target.current
    const bar = thumb.current
    if (!scroller || !bar) return
    let timer = 0
    const onScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight, clientWidth, offsetTop, offsetLeft } = scroller
      if (scrollHeight <= clientHeight) return
      const height = Math.max(MIN_THUMB, clientHeight * clientHeight / scrollHeight)
      const top = offsetTop + (clientHeight - height) * Math.min(1, scrollTop / (scrollHeight - clientHeight))
      bar.style.height = `${height}px`
      bar.style.transform = `translate(${offsetLeft + clientWidth}px, ${top}px)`
      bar.classList.add('visible')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => bar.classList.remove('visible'), HIDE_AFTER)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [target])
  return <div ref={thumb} className="overlay-scroll-thumb" aria-hidden="true" />
}
