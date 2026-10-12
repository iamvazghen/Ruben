---
name: personal-finance
description: Day-to-day money — record purchases, payslips and subscriptions from what the owner says or sends, keep them complete, and produce monthly/quarterly/annual results with cost cuts. Triggers on "I bought…", "I paid…", "add my payslip", "new subscription", "cancel …", "how much did I spend", "where can I save", "send me the monthly report", "budget", or a bank statement CSV.
---

# Personal Finance Skill

R.U.B.E.N. should know every euro that comes in and goes out. Complete records
beat clever analysis: a report on half the purchases is wrong, not approximate.

## Recording

**A purchase** (`spending add`): date, amount, currency, merchant, what was
bought (items when the owner lists them), category, payment method, and where
the receipt is. If the owner says "yesterday at IKEA, 89 for a shelf", that is
enough: fill date, merchant, amount, description, category `home`, and ask only
for what is genuinely missing. Read the result back in one line before saving.

**Many purchases**: ask for the bank or card statement as CSV (in Telegram,
send the file; in the CLI, `/spending <path>`). Review the preview's
categories with the owner; correct any with `spending set_category` — the
merchant is remembered for next time.

**A payslip** (`salary add_payslip`): gross, net, income tax, each social
contribution, bonus, pay date and the month it is for. The tool checks that
gross minus deductions equals net; if it does not, ask.

**A subscription** (`subscriptions add`): name, provider, plan, price,
currency, cycle, first billing date, trial end, notice period, minimum term,
payment method, account email, cancel link, who shares it, how often it is
used. When a price changes, `update` the amount: the history is kept.
Cancelling in RUBEN records it; remind the owner to cancel with the provider
before the cancel-by date.

## Results

`finance_report` for a month, quarter or year — always against the previous
period and the same period last year. Send it to Telegram when asked
(`send_telegram`). In the reply lead with what changed and why, then the top
cost cuts from the Optimisation sheet with their money value. Monthly,
quarterly and annual reports also run on schedule.

## Cutting costs

Lead with the largest annual saving. Typical, in order: subscriptions used
rarely or never; overlapping subscriptions in one category; monthly billing
that is cheaper yearly; categories over budget or growing more than 20 %;
merchants that take a large share of spending. Suggest a budget
(`spending budget_set`) for any category that keeps growing.

## Privacy

These records are the owner's alone. Never repeat salary, balances or
purchases into memory notes, other chats or anything outside the owner's own
conversation.
