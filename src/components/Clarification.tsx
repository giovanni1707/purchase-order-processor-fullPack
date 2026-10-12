import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import type { Choice } from '../services/quotation';

export interface ChatMessage {
  id: number;
  role: 'assistant' | 'user';
  text: string;
}

/** Chat used when the quotation contains something that must not be guessed. One question at a time. */
export default function Clarification(props: {
  messages: ChatMessage[];
  choices?: Choice[];
  remaining: number;
  busy: boolean;
  onAnswer: (text: string) => void;
  onRestart: () => void;
}) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [props.messages.length, props.busy]);

  const send = (value: string) => {
    if (!value.trim() || props.busy) return;
    props.onAnswer(value.trim());
    setText('');
  };

  return (
    <div className="mt-6 space-y-3" data-testid="clarification">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-amber-700">A few things need your answer</div>
        <div className="text-xs text-slate-500">{props.remaining > 0 ? `${props.remaining} question${props.remaining === 1 ? '' : 's'} left` : ''}</div>
      </div>
      <div className="max-h-80 space-y-2 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
        {props.messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-slate-900 text-white' : 'bg-white text-slate-800 shadow-sm'}`}>{m.text}</div>
          </div>
        ))}
        {props.busy && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" /> Working…
          </div>
        )}
        <div ref={end} />
      </div>
      {props.choices && props.choices.length > 0 && !props.busy && (
        <div className="flex flex-wrap gap-2">
          {props.choices.map((c) => (
            <button key={c.value} type="button" onClick={() => send(c.value)} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-500">
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(text)}
          placeholder="Type your answer"
          disabled={props.busy}
          aria-label="Your answer"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50"
        />
        <button type="button" onClick={() => send(text)} disabled={props.busy || !text.trim()} className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
          <Send className="h-4 w-4" /> Send
        </button>
      </div>
      <button type="button" onClick={props.onRestart} className="text-xs text-slate-500 underline">
        Start over
      </button>
    </div>
  );
}
