import noHandSetChangeDetection from './rules/no-hand-set-change-detection.ts';
import noComponentSubscribe from './rules/no-component-subscribe.ts';
import noFormsModule from './rules/no-forms-module.ts';
import noRestatedValidator from './rules/no-restated-validator.ts';
import noPresentationalInject from './rules/no-presentational-inject.ts';
import noReactiveForm from './rules/no-reactive-form.ts';
import noNgModel from './rules/no-ng-model.ts';
import noRootProvidedViewModel from './rules/no-root-provided-view-model.ts';
import noStateOutsideViewModel from './rules/no-state-outside-view-model.ts';
import noFeatureInjectData from './rules/no-feature-inject-data.ts';
import noUnprovidedViewModel from './rules/no-unprovided-view-model.ts';
import noExplicitStandalone from './rules/no-explicit-standalone.ts';
import noLegacyIconModule from './rules/no-legacy-icon-module.ts';
import noUnregisteredIcon from './rules/no-unregistered-icon.ts';
import noOrphanNgSubmit from './rules/no-orphan-ng-submit.ts';

// The `shape` eslint plugin: the Part 3 component-shape rules, encoding the
// component-shape spec (../component-shape-spec.md). It is the second of the two
// independent engines; the other is harness/counter/component-shape-counter.mjs.
// They share the spec, not code. The TypeScript rules run under typescript-eslint;
// no-ng-model and no-orphan-ng-submit run under the angular-eslint template
// parser. messageId -> kind:
//   handSetChangeDetection -> hand-set-change-detection
//   componentSubscribe     -> component-subscribe        (widened: also fires in ViewModels)
//   formsModule            -> template-driven-form  (TypeScript half)
//   ngModel                -> template-driven-form  (template half)
//   restatedValidator      -> restated-validator
//   presentationalInject   -> presentational-injects-data
//   reactiveForm           -> reactive-form
//   vmNotComponentScoped   -> vm-not-component-scoped   (capstone MVVM, rule 7)
//   stateOutsideVm         -> state-outside-vm           (capstone MVVM, rule 8; widened: also fires on form(...))
//   featureInjectsData     -> feature-injects-data       (capstone MVVM, rule 9)
//   vmNotProvided          -> vm-not-provided            (capstone MVVM, rule 10)
//   explicitStandalone     -> explicit-standalone        (capstone-residue, rule 11)
//   legacyIconModule       -> legacy-icon-module         (capstone-residue, rule 12)
//   unregisteredIcon       -> unregistered-icon          (capstone-residue, rule 13)
//   orphanNgSubmit         -> orphan-ng-submit           (capstone-residue, rule 14, template)
// The two heuristics (hand-written-form-model, dumb-holds-state) are counter-only
// and deliberately have no gate rule.
const plugin = {
  meta: { name: 'shape', version: '1.0.0' },
  rules: {
    'no-hand-set-change-detection': noHandSetChangeDetection,
    'no-component-subscribe': noComponentSubscribe,
    'no-forms-module': noFormsModule,
    'no-restated-validator': noRestatedValidator,
    'no-presentational-inject': noPresentationalInject,
    'no-reactive-form': noReactiveForm,
    'no-ng-model': noNgModel,
    'no-root-provided-view-model': noRootProvidedViewModel,
    'no-state-outside-view-model': noStateOutsideViewModel,
    'no-feature-inject-data': noFeatureInjectData,
    'no-unprovided-view-model': noUnprovidedViewModel,
    'no-explicit-standalone': noExplicitStandalone,
    'no-legacy-icon-module': noLegacyIconModule,
    'no-unregistered-icon': noUnregisteredIcon,
    'no-orphan-ng-submit': noOrphanNgSubmit,
  },
};

export default plugin;
