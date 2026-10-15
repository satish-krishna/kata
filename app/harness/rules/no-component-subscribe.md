# no-component-subscribe

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `componentSubscribe`. Counter kind: `component-subscribe`. Widened: also fires inside a ViewModel class.

## What it forbids

A call expression of the form `<expr>.subscribe(...)` textually inside the body of a class decorated with `@Component`, or inside a class whose name ends in `ViewModel`.

## Why

`CLAUDE.md`: "Use the async pipe to handle observables." A component that calls `.subscribe(...)` is hand-managing a subscription where the template's async pipe (or `toSignal`) would do it. The residue this rule targets is the reflex of subscribing to route params, a service observable, or a `valueChanges` stream inside `ngOnInit`.

The rule originally exempted every class but `@Component` ones, on the grounds that `.subscribe` is legitimate in a service. The MVVM refinement then created a class that is a service by decorator and a component's brain by role — the ViewModel — and two capstone trials put `this.route.paramMap.subscribe(...)` in a ViewModel constructor. The gate did not stop the subscribe; it relocated it into the one class the original scope note exempted. The predicate is now `@Component` classes plus classes whose name ends in `ViewModel`. The house doc's own definition of a ViewModel — unit-testable with zero DOM — is precisely the argument against a hand-managed subscription living there.

The check is syntactic (a member access named `subscribe`), so a variable literally named `subscribe` that is not a call is not flagged, and the false-positive risk of a non-RxJS `.subscribe` in a component is accepted: the whole point is that a component or ViewModel should not be the place subscriptions live.

## Accepted form

    protected readonly heroes = toSignal(this.heroService.list(), { initialValue: [] });

    <!-- or, in the template -->
    @if (heroes$ | async; as heroes) { ... }

## Agent guidance

Convert an observable at the edge, with `toSignal` or the async pipe, never by calling `.subscribe` inside a component or ViewModel.

    Good: protected readonly heroes = toSignal(this.heroService.list(), { initialValue: [] });
    Bad:  ngOnInit() { this.heroService.list().subscribe(h => this.heroes = h); }

## Known blind spots

- Scoped to `@Component` and `*ViewModel` classes only. A plain service or resolver calling `.subscribe` is legitimate and untouched, and a class that hand-manages state without being named `*ViewModel` or `@Component` also goes unchecked, though the house doc gives it nowhere else to live.
- Purely syntactic: it matches the member name `subscribe` on any callee, not specifically an RxJS `Observable`. A non-RxJS object with its own `.subscribe(...)` method would also be flagged.
