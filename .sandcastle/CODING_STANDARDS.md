# Coding Standards

## Style

- **Models** (`src/models/`) — `PascalCase` singular filenames (`Product.ts`). Contain only `interface` / `type` definitions. No classes, no functions.
- **ViewModels** (`src/viewmodels/`) — `PascalCase` + `ViewModel` suffix (`ProductListViewModel.ts`). Class name matches filename.
- **Views** (`src/views/` or `app/**`) — `PascalCase` matching what they render (`ProductList.tsx`).
- **Services** (`src/services/`) — `camelCase` (`productService.ts`).
- **Tests** — ViewModel name + `.test.ts` (`ProductListViewModel.test.ts`) in `__tests__/`.
- ViewModel state fields are `private` and prefixed with `_` (`_products`, `_isLoading`, `_error`). Expose via `public` getters.
- Prefer named exports.

## Testing

- Every ViewModel has a matching test file in `__tests__/`. No ViewModel ships without tests. **Exception:** `BaseViewModel.ts` is abstract infrastructure and is exempt from this rule (its behavior is exercised through every concrete ViewModel's tests).
- Test the **public surface only** — getters and public methods. Test private methods indirectly through the public methods that use them.
- Mock external dependencies (services, storage, timers) by passing a stub that implements the dependency interface through the constructor. Never use `vi.spyOn` or module mocking for ViewModel dependencies.
- Never make real network requests in tests.
- One `describe` block per ViewModel, one `it` block per behavior.
- Cover: initial state, state after each public method, error states, edge cases (empty/null), and computed/derived values.
- Aim for ≥90% line coverage on ViewModels. Don't chase coverage on Views.
- For optimistic updates, explicitly test the rollback path with a failing service mock.
- For real-time ViewModels, test by calling `updateX()` directly with mock data — no subscription mocking needed.

## Architecture

This project uses **Strict MVVM**. Every file belongs to exactly one layer.

### Layer responsibilities

- **Model** — Data shape only. No logic, no methods.
- **ViewModel** — All business logic: state, validation, fetching, sorting, filtering, error handling. Plain TypeScript class extending `BaseViewModel`. Must work in plain Node/Vitest with zero UI dependencies.
- **View** — Renders ViewModel state, forwards user actions. Applies to React components AND CLI scripts. **Allowed:** iteration over ViewModel collections, conditional rendering on ViewModel booleans, reading ViewModel getters into JSX/output, presentation formatting (currency, dates, i18n, pluralization, string padding for CLI). **Not allowed:** filtering, sorting, aggregating, deriving values, validation, fetching, or any state the ViewModel doesn't already expose.
- **Service** — Thin wrapper over external systems (HTTP, storage, Server Actions). Returns plain data. No business logic, no state.

### Reference contracts

These shapes define what infrastructure ViewModels rely on. Flag PRs that add a `BaseViewModel.ts` or `useViewModel.ts` with a different surface unless the change is explicitly proposed and justified.

**`BaseViewModel`** (`src/viewmodels/BaseViewModel.ts`) — abstract class exposing exactly:

- `subscribe(listener: () => void): () => void` — registers a listener, returns an unsubscribe function.
- `getSnapshot(): number` — returns a monotonically increasing version number that changes on every `notify()`.
- `protected notify(): void` — increments the version and invokes all listeners. Only callable from subclasses.

The implementation detail (listener `Set` + version counter) is fixed; do not accept replacements based on RxJS, EventEmitter, or signal libraries without explicit team discussion.

**`useViewModel`** (`src/hooks/useViewModel.ts`) — `<T extends BaseViewModel>(factory: () => T): T`. The factory runs once on mount; the hook subscribes via `useSyncExternalStore` and returns the instance. Alternative bindings (MobX `observer`, Zustand store hook) are acceptable **only if the project has standardized on one** — mixing bindings within a project is a violation.

### Required patterns

- **Dependency injection** — ViewModels declare an `interface` for each external dependency and receive it via constructor. Never `import` a concrete service inside a ViewModel.
- **State shape** — Async ViewModels expose `_isLoading: boolean`, `_error: string | null`, and the data field. Use named loading flags (`_isSubmitting`, `_isLoadingOrder`) for multiple independent operations.
- **Error handling** — ViewModel catches all exceptions internally and stores a plain string in `_error`. Never throws to the View. Set `_error = null` at the start of each retry.
- **Notify discipline** — Async methods call `this.notify()` after mutating state at the start AND in the `finally` block. Sync methods call `this.notify()` once at the end.
- **Optimistic updates** — Snapshot current state → apply optimistic change → `notify()` → server call → on failure, restore snapshot + set `_error` → `notify()` in `finally`.
- **Real-time data** (Convex/Firebase/etc.) — ViewModel never subscribes. Subscription lives in the View; the View pushes data via `vm.updateX(data)`.
- **CLI Views** — Argument parsing, `console.log`, `process.exit`, and prompt libraries (`inquirer`, etc.) all belong in the View. The ViewModel returns data; the View formats and exits.

### Hard prohibitions

| Violation | Required fix |
|---|---|
| ViewModel imports React, ReactDOM, JSX, or DOM APIs | Remove the import; move UI concern to View |
| ViewModel imports a concrete service from `services/` | Define an interface and inject via constructor |
| ViewModel imports another ViewModel | Use a shared service or pass data via the View |
| ViewModel returns JSX or UI-specific types | Return plain data; let View render it |
| ViewModel throws to the View | Catch internally, store in `_error` |
| ViewModel calls `process.exit` or `console.log` (CLI) | Move to the View entry script |
| View contains sorting, filtering, validation, or aggregation | Move to a ViewModel getter or method |
| View calls a service for data access (`fetch`, `axios`, `service.getX()` in render or handlers) | Call a ViewModel method instead. *Importing a service to inject it into a ViewModel factory is allowed.* |
| Service A and Service B import each other | Extract shared concern into Service C |
| Class or function in `src/models/` | Models hold only `interface` / `type` |
| Public mutation of a `_field` from outside the class | Expose a method; keep the field private |
| Missing `notify()` after a state mutation | Add it (start + `finally` for async) |
| Optimistic update without rollback snapshot | Add snapshot; restore on `catch` |
| In-place mutation of a `_field` (e.g., `_items.push(x)`) | Replace the field (`_items = [..._items, x]`) |
| ViewModel constructor calls an async method, starts a timer, or fetches | Move the call to the View or a factory; constructor only stores deps |
| ViewModel exposes pre-formatted display strings (currency, dates) | Expose raw values; format in the View |
| `useEffect` in a View used for state, derived values, or fetching | Move to ViewModel. (Mount-trigger and real-time push effects are allowed.) |
| One ViewModel handling multiple unrelated features | Split per feature/screen |
| New ViewModel without a `*.test.ts` file | Add the test file |

### Folder layout

```
src/
├── models/        # interface / type only
├── viewmodels/    # BaseViewModel.ts + one ViewModel class per feature
├── views/         # React components or CLI entry scripts
├── services/      # API clients, storage wrappers, Server Action wrappers
├── hooks/         # useViewModel.ts and shared hooks
└── __tests__/     # mirrors viewmodels/
```

### Next.js notes

- Server Components MAY import services directly — the DI rule applies only to ViewModels.
- Client Components instantiate the ViewModel, seed it with server-fetched props in the factory, and bind via `useViewModel`.
- Server Actions are wrapped behind a Service interface like any other dependency.

### Clarifications

These resolve common ambiguities. Apply them consistently during review.

- **`useEffect` in Views is allowed for two purposes only:** (1) triggering a ViewModel method on mount (`useEffect(() => { vm.loadX(); }, [])`), and (2) pushing real-time data into a ViewModel (`useEffect(() => { if (data) vm.updateX(data); }, [data])`). It is NOT allowed for local state, derived values, or data fetching. Prefer server-side seeding over the mount-effect pattern when available.

- **Constructor side effects are forbidden.** A ViewModel constructor stores injected dependencies and initializes state. It does NOT call its own async methods, start timers, or trigger network requests. The View (or factory) decides when to call `vm.loadX()`. This keeps ViewModels predictable in tests.

- **State must be replaced, not mutated.** Use `this._items = [...this._items, x]`, never `this._items.push(x)`. Mutating a field in place defeats memoization, breaks optimistic-update rollbacks, and confuses change detection. Flag any in-place mutation of a `_field`.

- **Presentation formatting lives in the View.** ViewModels expose raw values (`price: 1099` cents, `Date` objects, plain numbers). Views format them for display (`$10.99`, localized date strings, pluralized counts). A ViewModel returning a pre-formatted string is a violation unless the format itself is business logic (e.g., a generated SKU).

- **Next.js server/client boundary.** A file marked `"use server"` exports only async functions and runs server-side. It cannot be imported into a Client Component bound to a ViewModel. If a Server Action is part of a Service used by a ViewModel, the Service file itself must not be `"use server"` — it wraps the action and re-exports it through a normal client-importable interface.

- **Dependency interface location.** A ViewModel's dependency interface (e.g., `interface ProductService { fetchProducts(): Promise<Product[]> }`) lives **in the ViewModel file itself**, exported alongside the class. It does NOT go in `models/` (those are domain types, not contracts) and does NOT go in `services/` (the service implements the interface; the consumer owns it). This makes the ViewModel self-contained: one file shows the class, its state, and exactly what it needs from the outside world.

- **ViewModel scope.** Each `useViewModel(() => new XViewModel(...))` call creates an independent instance — two components calling this for the same class get two unrelated ViewModels. This is correct for screen-scoped state (a form, a list view). For state that must be shared across components (cart contents, auth user, app settings), do NOT instantiate the ViewModel in multiple places — instead share data through a singleton service that both ViewModels depend on, or lift the ViewModel to a parent component and pass the instance down via props or context. Flag PRs that instantiate the same ViewModel class in two sibling components when the data is clearly meant to be shared.
