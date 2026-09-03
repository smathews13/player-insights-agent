import { AppMultiSelect } from './AppMultiSelect';
import type { RailOwner } from './conversation-rail';
import { identityName } from './user-identity';
import { ownerSelectionSummary, toggleOwnerSelection } from './conversation-owner-selection';

export function ConversationOwnerSelect({
  owners,
  total,
  selected,
  onChange,
}: {
  owners: readonly RailOwner[];
  total: number;
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  const summary = ownerSelectionSummary(selected, owners);

  return (
    <AppMultiSelect
      label="Conversation owners"
      ariaLabel="Filter conversations by owner"
      summary={summary}
      allLabel="All users"
      total={total}
      selected={selected}
      onChange={onChange}
      toggleValue={toggleOwnerSelection}
      className="conversation-owner-select"
      contentClassName="conversation-owner-menu"
      options={owners.map((owner) => {
        const displayName = identityName(owner.email);
        return {
          value: owner.key,
          label: owner.you ? `You, ${displayName}` : displayName,
          ariaLabel: `${owner.you ? `You, ${displayName}` : displayName}, ${owner.count} conversation${
            owner.count === 1 ? '' : 's'
          }`,
          title: owner.email,
          count: owner.count,
          content: owner.you ? (
            <>
              <strong>You</strong>
              <span className="conversation-owner-option-detail"> · {displayName}</span>
            </>
          ) : (
            displayName
          ),
        };
      })}
    />
  );
}
