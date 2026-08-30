import { Check, Loader2 } from "lucide-react";

export default function TaskProgressSteps({ steps, activeIndex, detail }: { steps: string[]; activeIndex: number; detail?: string }) {
  return (
    <div className="task-progress-steps" role="status" aria-live="polite" aria-atomic="true">
      <div className="task-progress-steps__items">
        {steps.map((step, index) => {
          const completed = index < activeIndex;
          const active = index === activeIndex;
          return (
            <div key={step} className={`task-progress-step${completed ? " is-complete" : ""}${active ? " is-active" : ""}`}>
              <span className="task-progress-step__icon">
                {completed ? <Check size={12} /> : active ? <Loader2 size={13} className="spinner" /> : index + 1}
              </span>
              <span>{step}</span>
            </div>
          );
        })}
      </div>
      {detail && <div className="task-progress-steps__detail">{detail}</div>}
    </div>
  );
}
