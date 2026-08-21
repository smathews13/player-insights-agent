import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { NO_AGENT_MODEL, type AgentModelReference } from '../../shared/agent-model';
import { agentModelFromResponse } from './agent-model-response';

/**
 * One row in Settings: where to read the code that is answering.
 *
 * WHY THE ROW EXISTS. `agent.py` is the whole orchestrator -- the prompts, the
 * refusals, the field binding -- and it is not in this app. It is an artifact of
 * the registered model version the serving endpoint answers out of, so a reader
 * evaluating an answer had no way from inside the product to see the code that
 * produced it. They had to be told a catalog, a schema, a model and a version by
 * somebody, in a message, and then find it by hand.
 *
 * WHY IT NAMES THE ARTIFACTS TAB IN WORDS. The link goes to the model version
 * page, which is as deep as a Databricks URL goes: the tabs on that page --
 * Overview, Lineage, Artifacts, Traces -- are not separately addressable as far
 * as this app can establish, and a made-up query parameter would land on
 * Overview while claiming to land on the file. So the row says which tab, and
 * the link puts the reader one click from it.
 *
 * WHY IT CAN SAY NOTHING. A deployment whose endpoint would not describe itself,
 * or that was never told its own workspace host, has no address for its own
 * code. That is reported as not established rather than papered over with a link
 * to a workspace that may not be the reader's -- the rule the whole of
 * `databricks-links.ts` exists to hold.
 */
export function AgentCodeRow({ initialData }: { initialData?: unknown }) {
  const normalizedInitial = initialData === undefined ? null : agentModelFromResponse(initialData);
  const [model, setModel] = useState<AgentModelReference>(normalizedInitial ?? NO_AGENT_MODEL);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(normalizedInitial ? 'ready' : 'loading');

  useEffect(() => {
    if (initialData !== undefined) return;
    let current = true;
    fetch('/api/settings/agent-model')
      .then(async (response) => {
        if (!response.ok) throw new Error('The agent model could not be read.');
        return agentModelFromResponse(await response.json());
      })
      .then((payload) => {
        if (!current) return;
        setModel(payload);
        setState('ready');
      })
      .catch(() => {
        if (current) setState('failed');
      });
    return () => {
      current = false;
    };
  }, [initialData]);

  return (
    <div className="settings-row agent-code-row">
      <div>
        <p className="settings-row-label">Agent code</p>
        <p className="settings-row-note">{note(state, model)}</p>
      </div>
      {model.url ? (
        <a
          className="agent-code-open"
          href={model.url}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="agent-code-link"
        >
          <span>{model.versioned ? 'Open agent.py' : 'Open the model'}</span>
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

/**
 * The sentence beside the link, which is different in every case for a reason.
 *
 * Four outcomes and four sentences. Collapsing "no version reported" into the
 * good case would leave the row promising a reader the exact code that answered
 * and handing them a model page listing several versions, and collapsing "no
 * workspace host" into "nothing found" would hide a model this deployment
 * plainly knows the name of.
 */
function note(state: 'loading' | 'ready' | 'failed', model: AgentModelReference): string {
  if (state === 'loading') return 'Looking up which version of the agent is answering.';
  if (state === 'failed') {
    return 'The serving endpoint could not be asked which version of the agent is answering, so there is nothing to open.';
  }
  if (!model.model) {
    return 'Not set. Nothing told this deployment which registered model answers its questions.';
  }
  if (!model.url) {
    return `This deployment serves ${model.model}, but it was not told which workspace it is in, so there is no page to open.`;
  }
  if (!model.versioned) {
    return (
      `${model.model} is the registered agent model. The endpoint did not report which version is ` +
      'serving, so this opens the model rather than one version; the code is under the Artifacts tab of a version.'
    );
  }
  return (
    `Version ${model.version} of ${model.model} is answering. This opens that version in Catalog Explorer, ` +
    'where agent.py is under the Artifacts tab.'
  );
}
