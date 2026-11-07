// Static column projections bound damaged SQLite values before materializing them in JavaScript.
export function textColumn(column: string, maximum: number, nullable = false): string {
  if (!/^[a-z_]+$/.test(column) || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error('Invalid SQL projection');
  return `CASE WHEN length(CAST(${column} AS BLOB))>${maximum} THEN ${nullable ? '0' : 'NULL'} ELSE ${column} END AS ${column}`;
}
