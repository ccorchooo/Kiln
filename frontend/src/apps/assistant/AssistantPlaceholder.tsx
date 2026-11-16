import { useEffect, useState } from "react";
import { useAuth } from "../../lib/store";
import { APPS, AppPlaceholder } from "../../shell/apps";
import { useWM } from "../../shell/wm";

/** Until Phase 6: shows the question that was handed over from Spotlight or the Home pill. */
export default function AssistantPlaceholder() {
  const name = useAuth((s) => s.assistantName);
  const pending = useWM((s) => s.pendingAsk);
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (pending !== null) setAsked(useWM.getState().consumeAsk());
  }, [pending]);
  return (
    <div className="flex h-full flex-col">
      {asked && (
        <div className="mx-auto mt-8 w-[min(560px,90%)] rounded-[16px] bg-accent-soft px-5 py-4">
          <p className="text-xs text-accent-ink">You asked</p>
          <p className="heading-display text-xl text-ink">“{asked}”</p>
          <p className="mt-1 text-sm text-ink-2">{name} will answer here once the assistant is connected.</p>
        </div>
      )}
      <div className="flex-1">
        <AppPlaceholder app={{ ...APPS.assistant!, name }} />
      </div>
    </div>
  );
}
