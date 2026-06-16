# TASK

Review the code changes for issue {{TASK_ID}}: {{ISSUE_TITLE}}

The branch is `{{BRANCH}}`. Find actionable issues only. Do not edit files. Do not make commits. Do not close the issue.

# CONTEXT

## Issue

!`gh issue view {{TASK_ID}} --json number,title,body,comments,labels --jq '{number, title, body, labels: [.labels[].name], comments: [.comments[].body]}'`

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for actionable improvements**: Look for issues that should block merge:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality**: Flag any finding that would change what the code does. All original features, outputs, and behaviors must remain intact.

7. **Preserve issue completion**: Flag any finding that removes or weakens behavior required by the issue.

# OUTPUT

If there are actionable findings, list them with:

- Severity
- File or area
- What is wrong
- What the implementer should change

If there are no actionable findings, output exactly:

<review>NO_ACTIONABLE_FINDINGS</review>
