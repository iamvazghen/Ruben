/** Names only, no imports: commands/finance.ts needs them without pulling the whole tool graph (it is itself imported by a tool). */
export const MONEY_COMMANDS = ['networth', 'holdings', 'accounts', 'jurisdiction', 'transfers', 'subs', 'salary', 'budget',
  'alerts', 'forecast', 'property', 'taxyear', 'export', 'importsheet'] as const;
