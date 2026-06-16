# TASK

Check whether issue {{TASK_ID}} is fully completed on branch `{{BRANCH}}`.

This is a verification pass only. Do not edit files. Do not make commits. Do not close the issue.

# ISSUE

!`gh issue view {{TASK_ID}} --json number,title,body,comments,labels --jq '{number, title, body, labels: [.labels[].name], comments: [.comments[].body]}'`

# BRANCH DIFF

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

# COMMITS ON THIS BRANCH

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW

Decide if the implementation fully satisfies the issue. Be strict:

- All explicit requirements in the issue must be implemented
- Relevant edge cases must be handled
- Tests or verification must exist when the change is testable
- The branch must not contain unrelated work
- Do not mark complete just because commits exist

If work is incomplete, write clear implementation feedback that can be handed directly back to the implementer.

# OUTPUT

Output exactly one JSON object wrapped in `<completion-check>` tags, then output `<promise>COMPLETE</promise>`.

Use this shape:

<completion-check>
{
  "complete": false,
  "summary": "Short summary of what is done or not done.",
  "missing": ["Concrete missing item"],
  "feedback": "Direct instructions for the implementer on what to do next."
}
</completion-check>

Set `complete` to `true` only when the issue is fully complete. When `complete` is `true`, `missing` must be an empty array.
