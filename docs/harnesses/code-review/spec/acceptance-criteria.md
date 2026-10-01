# Acceptance criteria rows

One JSON file format carries the constraints a change is meant to satisfy. The
code-review harness reads it in its optional `conformance` role
([ADR 0025](../../../adr/0025-plan-conformance-role.md)). The format is meant
for any check of a change against its plan, so write the rows once, from the
plan or the hand-off's binding-constraints table, and point every such check at
the same file. The parser is `parseAcceptanceCriteria` in `@aguil/agents-core`.

## Format

```json
{
  "version": 1,
  "source": "docs/plans/hashing.md#slice-3",
  "criteria": [
    {
      "id": "AC-1",
      "statement": "The canonical hash does not depend on map insertion order; it never hashes serializer output.",
      "check": "diff",
      "required_tests": [
        "hash is equal for maps built in reverse insertion order"
      ]
    },
    {
      "id": "AC-2",
      "statement": "The fallback uses stored values when they are non-empty and only otherwise returns the default.",
      "check": "diff"
    },
    {
      "id": "AC-3",
      "statement": "A cold start completes without network access.",
      "check": "runtime"
    }
  ]
}
```

| Field                       | Required | Meaning                                                                                                                                 |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                   | yes      | Always `1`.                                                                                                                             |
| `source`                    | no       | Where the rows came from. Free text; a path and anchor is most useful.                                                                  |
| `criteria`                  | yes      | Non-empty list of rows.                                                                                                                 |
| `criteria[].id`             | yes      | Unique in the file. Letters, digits, `.`, `_`, `-`; starts with a letter or digit. No commas, because run metadata joins ids with them. |
| `criteria[].statement`      | yes      | The constraint, stated so a reader can tell whether code meets it.                                                                      |
| `criteria[].check`          | no       | `diff` (default) when the change itself can show the row holds; `runtime` when only running code can.                                   |
| `criteria[].required_tests` | no       | Tests the change must add, by name or description. A counterexample regression test belongs here.                                       |

Any defect fails the whole file: invalid JSON, an unknown key (so a misspelled
`required_tests` cannot quietly mean "no tests"), a wrong `version`, an empty
list, a malformed or duplicate `id`, an empty `statement`, an unknown `check`. A
row that quietly drops out is a constraint nobody checks.

Write each `statement` as the rule, including its conditions. "Use stored
values" loses the condition that made the original design correct; "use stored
values when they are non-empty" keeps it.

## Supplying rows to code review

The `acceptance-criteria` context provider looks for rows in this order and uses
the first source it finds:

1. `agents code-review --criteria <path>`. The path resolves against the
   invoking directory and may sit outside the workspace. An unusable file aborts
   the run. The flag is CLI-only; config files and `AGENTS_CODE_REVIEW_*` cannot
   set it.
2. The provider's `path` param in `harness.yaml`, relative to the workspace. A
   missing file means no criteria.
3. `Acceptance-Criteria: <path-or-url>` lines in the PR description, one per
   file. Paths must stay inside the workspace. URLs must be on the same host and
   owner as the tracked remote, the same rule PR-referenced docs follow. Rows
   from several lines merge; a repeated `id` makes the set invalid.

The provider always emits one `acceptance-criteria` artifact whose JSON content
has `status` (`loaded`, `absent`, or `invalid`), `reason`, `sources`, and
`criteria`. The harness binds the loaded row count as the CEL variable
`acceptance_criteria`, and the `conformance` role is enabled when it is above
zero.

## What the conformance role reports

For each row the role emits one outcome with `kind: "conformance"` and `data`
holding `criterion`, `status`, and `detail`:

| Status         | Meaning                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `satisfied`    | Code implements the row, and every required test is in the change.                              |
| `unsatisfied`  | Code contradicts the row, or a required test is missing. `detail` says what differs.            |
| `unverifiable` | Neither the diff nor the code it touches shows whether the row holds. `detail` says what would. |

Each `unsatisfied` row is also a `critical` finding and each `unverifiable` row
a `warning` finding, titled with the row id in brackets (`[AC-2] …`), so they
reach run status and the triage queue like any other finding.

`report.md` gets a **Plan Conformance** section listing every row with its
status. A row the role never reported is listed as having no result. When the
role did not run, the section says why.
