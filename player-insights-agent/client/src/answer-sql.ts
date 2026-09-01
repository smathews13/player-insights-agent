/** Generated SQL is an answer detail only when a statement actually exists. */
export function answerHasGeneratedSql(sql: string): boolean {
  return Boolean(sql.trim());
}
