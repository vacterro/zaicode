import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ZCodeIntlProvider } from '@/i18n/IntlProvider.js';
import { ConversationTurnGroup } from '@/v4/ConversationTurnGroup.js';
import { ConversationShareReadonlyTimeline } from '@/v4/ConversationShareReadonlyTimeline.js';
import { buildConversationTurnRenderUnits } from '@/v4/conversationTurnRenderUnits.js';
const base = Date.parse('2026-10-03T10:00:00Z');
globalThis.fixture = { rowRenders: 0, terminalRenders: 0, terminalMounts: 0, inputs: [] };
const cases = [
  ['normal', base - 9_300_000], ['fresh', base - 10], ['restored', base - 9_300_000],
  ['detached', base - 9_300_000], ['missing', undefined], ['zero', 0], ['negative', -1],
  ['nan', NaN], ['infinite', Infinity], ['future', base + 100_000],
  ['completed', base - 9_300_000], ['interrupted', base - 9_300_000], ['idle', undefined],
  ['recorded', undefined],
];
function rows(id, startedAt) {
  const terminal = ['completed', 'interrupted', 'idle'].includes(id);
  const header = { kind: 'turnHeader', rowId: 0, turnId: id, executionKind: 'agent', startedAt,
    state: terminal ? id === 'interrupted' ? 'completedInterrupted' : 'completedSuccess' : 'running',
    ...(terminal && id !== 'idle' ? { endedAt: base, activeMs: 9_300_000 } : {}),
    ...(id === 'recorded' ? { activeMs: 0 } : {}),
  };
  return [header, { kind: 'reasoning', rowId: 1, turnId: id, entityId: 'reason', text: 'work history', state: 'complete' },
    { kind: 'assistantText', rowId: 2, turnId: id, entityId: 'answer', text: 'answer', state: terminal ? 'complete' : 'streaming', actions: {} }];
}
const context = { workspacePath: 'V:/fixture', theme: 'dark', messageStreamShowReasoning: true, chatLoadingBlockedByActiveWork: true };
const locale = new URL(location.href).searchParams.get('locale') || 'en-US';
function App() {
  const [newStart, setNewStart] = useState<number | null>(null);
  globalThis.fixture.restart = () => setNewStart(Date.now());
  return <ZCodeIntlProvider initialLocale={locale as never}><main>{cases.map(([id, startedAt]) => {
    const facts = rows(id, id === 'normal' && newStart !== null ? newStart : startedAt);
    const unit = buildConversationTurnRenderUnits(facts as never, { nowMs: Date.now() })[0]!;
    return <section data-case={id} key={id}><h3>{id}</h3><ConversationTurnGroup unit={unit} context={context as never}/>
      <div data-share={id}><ConversationShareReadonlyTimeline rows={facts as never} locale={locale as never}/></div>
    </section>;
  })}</main></ZCodeIntlProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
