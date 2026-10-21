import { ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';

export type TourStep = {
  id: string;
  target: string;
  title: string;
  description: string;
};

type Bounds = { left: number; top: number; width: number; height: number };
const modalSelector = '[role="dialog"][aria-modal="true"]';

export function WorkspaceTour({
  step,
  index,
  total,
  onBack,
  onNext,
  onClose,
  nextLabel,
  nextDisabled = false,
  side = 'right',
  inline = false,
  onSkipStep,
  skipStepLabel,
}: {
  step: TourStep;
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  side?: 'left' | 'right';
  inline?: boolean;
  onSkipStep?: () => void;
  skipStepLabel?: string;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusedStepRef = useRef<string | null>(null);
  const animatedStepRef = useRef<string | null>(null);
  const previousIndexRef = useRef(index);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [paused, setPaused] = useState(() => Boolean(document.querySelector(modalSelector)));

  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    return () => {
      if (
        (panel?.contains(document.activeElement) || document.activeElement === document.body) &&
        previous instanceof HTMLElement &&
        previous.isConnected
      ) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (paused || document.querySelector(modalSelector)) return;

    const previousStep = focusedStepRef.current;
    focusedStepRef.current = step.id;
    const active = document.activeElement;
    const editing = active?.closest('input, textarea, select, [contenteditable="true"]');
    if (
      !editing &&
      (previousStep === null || active === document.body || panelRef.current?.contains(active))
    ) {
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [step.id, paused]);

  useEffect(() => {
    if (paused) return;

    const previousStep = animatedStepRef.current;
    const direction = index >= previousIndexRef.current ? 1 : -1;
    animatedStepRef.current = step.id;
    previousIndexRef.current = index;
    if (previousStep === step.id || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const animation =
      previousStep === null
        ? panelRef.current?.animate(
            [
              {
                opacity: 0.4,
                transform: 'translateY(12px)',
                clipPath: 'inset(0 0 12% 0 round 16px)',
              },
              { opacity: 1, transform: 'translateY(0)', clipPath: 'inset(0 0 0% 0 round 16px)' },
            ],
            { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          )
        : contentRef.current?.animate(
            [
              {
                opacity: 0.25,
                transform: `translateX(${direction * 10}px)`,
                filter: 'blur(1.5px)',
              },
              { opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' },
            ],
            { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          );
    return () => animation?.cancel();
  }, [step.id, index, paused]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector(modalSelector)
      ) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  useEffect(() => {
    let target: Element | null = null;
    let frame = 0;
    const resize = new ResizeObserver(schedule);
    function update() {
      const modalOpen = Boolean(document.querySelector(modalSelector));
      setPaused(modalOpen);
      if (modalOpen) return;
      const nextTarget = document.querySelector(step.target);
      if (target !== nextTarget) {
        resize.disconnect();
        target = nextTarget;
        if (target) {
          resize.observe(target);
          if (!inline) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      const rect = target?.getBoundingClientRect();
      const viewport = target?.closest('.main-content')?.getBoundingClientRect();
      const left = Math.max((viewport?.left ?? 0) + 4, (rect?.left ?? 0) - 5);
      const top = Math.max((viewport?.top ?? 0) + 4, (rect?.top ?? 0) - 5);
      const right = Math.min((viewport?.right ?? window.innerWidth) - 4, (rect?.right ?? 0) + 5);
      const bottom = Math.min(
        (viewport?.bottom ?? window.innerHeight) - 4,
        (rect?.bottom ?? 0) + 5,
      );
      const next =
        rect?.width && rect.height && right > left && bottom > top
          ? { left, top, width: right - left, height: bottom - top }
          : null;
      setBounds((current) =>
        current?.left === next?.left &&
        current?.top === next?.top &&
        current?.width === next?.width &&
        current?.height === next?.height
          ? current
          : next,
      );
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    }
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'aria-modal'],
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  }, [step.target, inline]);

  if (paused) return null;

  return (
    <>
      {bounds && !inline ? (
        <div
          className="workspace-tour-target fixed z-40 pointer-events-none border-2 border-solid border-accent rounded-[12px] shadow-[0_0_0_9999px_rgb(0_0_0_/_0.32)] motion-safe:transition-[left,top,width,height] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={bounds}
          aria-hidden="true"
        />
      ) : null}
      <section
        ref={panelRef}
        className={`workspace-tour overflow-auto p-6 rounded-[16px] bg-surface text-foreground ${inline ? 'settings-card relative max-w-250 mb-6 border border-solid border-line' : `fixed z-[41] ${side === 'left' ? 'left-61 [.compact_&]:left-23' : 'right-6'} bottom-6 w-[min(380px,calc(100vw_-_32px))] max-h-[calc(100dvh_-_48px)] shadow-[0_18px_60px_rgb(0_0_0_/_0.28)] max-[600px]:right-4 max-[600px]:bottom-4 max-[600px]:max-h-[calc(100dvh_-_32px)] max-[600px]:p-5`}`}
        aria-label={t('tour.label')}
        aria-describedby={descriptionId}
      >
        <div className="absolute inset-x-0 top-0 h-0.75 bg-surface-highlight" aria-hidden="true">
          <div
            className="h-full bg-accent motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
        <div ref={contentRef} aria-live="polite" aria-atomic="true">
          <header className="flex items-baseline justify-between gap-4">
            <h2
              ref={titleRef}
              tabIndex={-1}
              className="text-[20px] font-[550] leading-[1.3] tracking-[-0.4px] [overflow-wrap:anywhere] focus:outline-none"
            >
              {step.title}
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              <span className="workspace-tour-progress text-muted text-[11px] tabular-nums">
                {t('tour.progress', { current: index + 1, total })}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={onClose}
                aria-label={t('tour.close')}
              >
                <X size={15} />
              </button>
            </div>
          </header>
          <p
            id={descriptionId}
            className="mt-3 text-secondary text-[13px] leading-[1.65] max-w-[70ch] [overflow-wrap:anywhere]"
          >
            {step.description}
          </p>
        </div>
        <footer className="flex items-center justify-between flex-wrap gap-3 mt-5.5">
          <button type="button" className="text-button" onClick={onSkipStep ?? onClose}>
            {skipStepLabel ?? t('tour.skip')}
          </button>
          <div className="workspace-tour-actions flex gap-2 ml-auto">
            {index > 0 ? (
              <button type="button" className="button" onClick={onBack}>
                {t('tour.back')}
              </button>
            ) : null}
            <button
              type="button"
              className="button primary"
              onClick={onNext}
              disabled={nextDisabled}
            >
              {nextLabel ?? t(index === total - 1 ? 'tour.finish' : 'tour.next')}
              {index === total - 1 ? <Check size={15} /> : <ArrowRight size={15} />}
            </button>
          </div>
        </footer>
      </section>
    </>
  );
}
