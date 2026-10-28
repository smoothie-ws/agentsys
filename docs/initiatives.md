# Initiatives

An Initiative is the managed project; a Project is the editor workspace containing workflows. Create one with `POST initiatives {title,goal,constraints?}`. `GET initiatives/{id}` reads its tasks, immutable decisions, artifacts and facts. All mutations append to `initiatives/<id>/log`; projections live under separate keys. `initiativeState(log)` reconstructs everything without storage.

Tasks use `todo`, `doing`, `blocked`, `done`, `cancelled`. `todo` can become `doing`, `blocked` or `cancelled`; `doing` can become `blocked`, `done` or `cancelled`; `blocked` can return to `todo` or `doing` or be cancelled. Finished/cancelled tasks are terminal. Starting or finishing requires all dependencies to be done. Dependency and parent cycles are rejected. Updates require the current record `version`; conflicting writes return 409. The request lock serializes journal appends.

Collections: `/tasks`, `/decisions`, `/artifacts`, `/facts`. List filters include `status`, `assignee`, `depends_on`, `ready=true` and `q`. Decisions and facts are append-only; supersede a decision by appending another with `supersedes`. Artifacts have either `uri` or `content_ref`, and increment their version when updated. Facts require provenance (`source`) and `confidence` from 0 to 1.

Controller shows task trees and decision history. `examples/initiative-nodes.json` contains the API wrappers; `examples/planner-task-runner.json` demonstrates orchestration. Grant the required `initiative.write:*` and `initiative.read` in the workspace policy before running the example. An Initiative's `budget_id` selects a shared budget (`GET/PUT budgets/{id}`); otherwise its own ID is used. Scripts use the API, so the executor has no task-specific logic.
