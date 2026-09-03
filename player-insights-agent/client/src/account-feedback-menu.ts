export function nextFeedbackItem(current: number, key: string, count = 2): number {
  if (key === 'Home') return 0;
  if (key === 'End') return Math.max(0, count - 1);
  const direction = key === 'ArrowUp' ? -1 : 1;
  return (current + direction + count) % count;
}
