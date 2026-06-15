/* Kata Design System — compiled component runtime.
 * Defines window.KataDesignSystem_dd74c7 with the 18 UI primitives
 * (Button, IconButton, TextInput, Textarea, Select, SegmentedControl,
 * Checkbox, Switch, Field, Badge, Tag, StatusDot, Kbd, Card,
 * EventRow, SummaryStat, KitItem, AskPanel).
 * Load AFTER React + ReactDOM. Generated artifact — do not edit by hand. */
(() => {

const __ds_ns = (window.KataDesignSystem_dd74c7 = window.KataDesignSystem_dd74c7 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/display/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Badge — a small mono status/label pill. */
function Badge({
  tone = "neutral",
  children,
  className = "",
  ...rest
}) {
  const cls = ["k-badge", `k-badge--${tone}`, className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Badge.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Card — solid surface container; flat at rest. */
function Card({
  inset = false,
  pad = false,
  title,
  actions,
  children,
  className = "",
  ...rest
}) {
  const cls = ["k-card", inset && "k-card--inset", pad && !title && "k-card--pad", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), title && /*#__PURE__*/React.createElement("div", {
    className: "k-card__header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-card__title"
  }, title), actions && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: "var(--space-2)"
    }
  }, actions)), title ? /*#__PURE__*/React.createElement("div", {
    className: "k-card__body"
  }, children) : children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/Kbd.jsx
try { (() => {
/** Kbd — a keyboard-key cap for shortcut hints. */
function Kbd({
  children,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("kbd", {
    className: ["k-kbd", className].filter(Boolean).join(" ")
  }, children);
}
Object.assign(__ds_scope, { Kbd });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Kbd.jsx", error: String((e && e.message) || e) }); }

// components/display/StatusDot.jsx
try { (() => {
const LABELS = {
  idle: "Idle",
  running: "Running",
  awaiting: "Awaiting input",
  success: "Completed",
  warning: "Stopped",
  error: "Error"
};

/** StatusDot — the andon stack-light. `running` pulses the accent; `awaiting` pulses amber. */
function StatusDot({
  state = "idle",
  label,
  className = ""
}) {
  const cls = ["k-status", `k-status--${state}`, className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", {
    className: cls
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-status__dot"
  }), /*#__PURE__*/React.createElement("span", null, label ?? LABELS[state]));
}
Object.assign(__ds_scope, { StatusDot });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/StatusDot.jsx", error: String((e && e.message) || e) }); }

// components/display/Tag.jsx
try { (() => {
/** Tag — the kit's skill/plugin classifier chip. */
function Tag({
  kind = "skill",
  className = "",
  children
}) {
  const cls = ["k-tag", `k-tag--${kind}`, className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", {
    className: cls
  }, children ?? kind);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Tag.jsx", error: String((e && e.message) || e) }); }

// components/forms/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Button — the primary action primitive. Vermilion `primary` for the one
 * decisive action (Run, Save); `secondary` / `ghost` for everything else.
 */
function Button({
  variant = "primary",
  size = "md",
  block = false,
  icon = null,
  iconRight = null,
  children,
  className = "",
  ...rest
}) {
  const cls = ["k-btn", `k-btn--${variant}`, size !== "md" && `k-btn--${size}`, block && "k-btn--block", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls
  }, rest), icon && /*#__PURE__*/React.createElement("span", {
    className: "k-btn__icon"
  }, icon), children && /*#__PURE__*/React.createElement("span", null, children), iconRight && /*#__PURE__*/React.createElement("span", {
    className: "k-btn__icon"
  }, iconRight));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Button.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Checkbox — labelled boolean. Vermilion fill when checked. */
function Checkbox({
  label,
  className = "",
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ["k-check", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox"
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "k-check__box",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "3.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "20 6 9 17 4 12"
  }))), label && /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Field.jsx
try { (() => {
/**
 * Field — label + control + hint wrapper. `specKey` renders the literal
 * lowercase run-spec key in mono next to the human label.
 */
function Field({
  label,
  specKey,
  hint,
  error,
  htmlFor,
  children,
  className = ""
}) {
  const cls = ["k-field", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: cls
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "k-field__label",
    htmlFor: htmlFor
  }, label, specKey && /*#__PURE__*/React.createElement("code", null, specKey)), children, (hint || error) && /*#__PURE__*/React.createElement("span", {
    className: ["k-field__hint", error && "k-field__hint--error"].filter(Boolean).join(" ")
  }, error || hint));
}
Object.assign(__ds_scope, { Field });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Field.jsx", error: String((e && e.message) || e) }); }

// components/forms/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** IconButton — a square, icon-only control for toolbars and dense chrome. */
function IconButton({
  size = "md",
  icon,
  className = "",
  ...rest
}) {
  const cls = ["k-iconbtn", size === "sm" && "k-iconbtn--sm", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls
  }, rest), icon);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/forms/SegmentedControl.jsx
try { (() => {
/**
 * SegmentedControl — 2–3 mutually-exclusive options. Used for the spec's
 * enum fields (identity mode append/replace, isolation none/worktree).
 */
function SegmentedControl({
  options,
  value,
  onChange,
  className = ""
}) {
  const cls = ["k-seg", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: cls,
    role: "tablist"
  }, options.map(o => {
    const v = typeof o === "string" ? o : o.value;
    const label = typeof o === "string" ? o : o.label ?? o.value;
    const active = v === value;
    return /*#__PURE__*/React.createElement("button", {
      key: v,
      type: "button",
      role: "tab",
      "aria-selected": active,
      className: ["k-seg__opt", active && "k-seg__opt--active"].filter(Boolean).join(" "),
      onClick: () => onChange && onChange(v)
    }, label);
  }));
}
Object.assign(__ds_scope, { SegmentedControl });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/SegmentedControl.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Select — native dropdown, themed. Pass options as [{value,label}] or children. */
function Select({
  options,
  className = "",
  children,
  ...rest
}) {
  const cls = ["k-select", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("select", _extends({
    className: cls
  }, rest), options ? options.map(o => /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label ?? o.value)) : children);
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Switch — on/off toggle for settings-like booleans. */
function Switch({
  label,
  className = "",
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ["k-switch", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch"
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "k-switch__track",
    "aria-hidden": "true"
  }), label && /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/TextInput.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** TextInput — single-line text field. Use `mono` for paths, models, codes. */
function TextInput({
  mono = false,
  invalid = false,
  className = "",
  ...rest
}) {
  const cls = ["k-input", mono && "k-input--mono", invalid && "k-input--invalid", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("input", _extends({
    className: cls
  }, rest));
}
Object.assign(__ds_scope, { TextInput });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/TextInput.jsx", error: String((e && e.message) || e) }); }

// components/forms/Textarea.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Textarea — multi-line field for task, context, system prompt. */
function Textarea({
  mono = false,
  className = "",
  rows = 4,
  ...rest
}) {
  const cls = ["k-textarea", mono && "k-textarea--mono", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("textarea", _extends({
    className: cls,
    rows: rows
  }, rest));
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Textarea.jsx", error: String((e && e.message) || e) }); }

// components/run/AskPanel.jsx
try { (() => {
/**
 * AskPanel — renders an intercepted `AskUserQuestion` as a HITL checkpoint.
 * Kata traps the tool call at the edge, pauses the run, and surfaces the
 * question(s) here; the operator's answer is fed back as the tool result.
 *
 * Each question is one of three kinds:
 *   • "confirm" — a yes/no (or two-option) inline choice
 *   • "select"  — multiple choice; radio rows, or checkboxes when multiSelect
 *   • "text"    — a free-form typed answer (optional via `optional: true`)
 *
 * questions: [{ kind?, header, question, options?, multiSelect?, optional?, placeholder? }]
 * Calls onSubmit(answers) where answers is string[][] (chosen labels / typed
 * text per question).
 */
function AskPanel({
  questions = [],
  tool = "AskUserQuestion",
  answered = false,
  answers: answeredWith,
  onSubmit,
  className = ""
}) {
  const init = () => questions.map(q => q.kind === "text" ? "" : []);
  const [sel, setSel] = React.useState(init);
  function pick(qi, label, multi) {
    setSel(prev => {
      const next = prev.map(a => Array.isArray(a) ? a.slice() : a);
      if (multi) next[qi] = next[qi].includes(label) ? next[qi].filter(l => l !== label) : [...next[qi], label];else next[qi] = [label];
      return next;
    });
  }
  function type(qi, value) {
    setSel(prev => {
      const next = prev.slice();
      next[qi] = value;
      return next;
    });
  }
  const isDone = (q, v) => q.kind === "text" ? q.optional || v && v.trim().length > 0 : v && v.length > 0;
  const complete = questions.every((q, qi) => isDone(q, sel[qi]));
  function submit() {
    const out = sel.map((v, i) => questions[i].kind === "text" ? [String(v).trim()].filter(Boolean) : v);
    onSubmit && onSubmit(out);
  }

  // What to show in the answered (read-only) state.
  const shown = qi => answered ? answeredWith ? answeredWith[qi] : sel[qi] : sel[qi];
  function renderOptions(q, qi, multi) {
    return /*#__PURE__*/React.createElement("div", {
      className: "k-ask__opts"
    }, q.options.map(o => {
      const isSel = (shown(qi) || []).includes(o.label);
      return /*#__PURE__*/React.createElement("button", {
        type: "button",
        key: o.label,
        disabled: answered,
        className: ["k-ask__opt", isSel && "k-ask__opt--selected"].filter(Boolean).join(" "),
        onClick: () => pick(qi, o.label, multi)
      }, /*#__PURE__*/React.createElement("span", {
        className: ["k-ask__mark", multi ? "k-ask__mark--check" : "k-ask__mark--radio"].join(" "),
        "aria-hidden": "true"
      }, multi ? /*#__PURE__*/React.createElement("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "3.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }, /*#__PURE__*/React.createElement("polyline", {
        points: "20 6 9 17 4 12"
      })) : /*#__PURE__*/React.createElement("span", {
        className: "k-ask__mark-dot"
      })), /*#__PURE__*/React.createElement("span", {
        className: "k-ask__opt-text"
      }, /*#__PURE__*/React.createElement("span", {
        className: "k-ask__opt-label"
      }, o.label), o.description && /*#__PURE__*/React.createElement("span", {
        className: "k-ask__opt-desc"
      }, o.description)));
    }));
  }
  function renderConfirm(q, qi) {
    const opts = q.options && q.options.length ? q.options : [{
      label: "Yes"
    }, {
      label: "No"
    }];
    return /*#__PURE__*/React.createElement("div", {
      className: "k-ask__confirm"
    }, opts.map(o => {
      const isSel = (shown(qi) || []).includes(o.label);
      return /*#__PURE__*/React.createElement("button", {
        type: "button",
        key: o.label,
        disabled: answered,
        className: ["k-ask__confirm-btn", isSel && "k-ask__confirm-btn--selected"].filter(Boolean).join(" "),
        onClick: () => pick(qi, o.label, false)
      }, o.label);
    }));
  }
  function renderText(q, qi) {
    if (answered) {
      const v = (shown(qi) || [])[0];
      return /*#__PURE__*/React.createElement("div", {
        className: "k-ask__answer"
      }, v ? v : /*#__PURE__*/React.createElement("span", {
        className: "k-ask__answer--empty"
      }, "\u2014 no note \u2014"));
    }
    return /*#__PURE__*/React.createElement(__ds_scope.Textarea, {
      rows: 2,
      value: sel[qi],
      placeholder: q.placeholder || "Type your answer…",
      onChange: e => type(qi, e.target.value)
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    className: ["k-ask", answered && "k-ask--answered", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("div", {
    className: "k-ask__banner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-ask__banner-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "k-ask__banner-label"
  }, answered ? "Answered · run resumed" : "Awaiting your input"), /*#__PURE__*/React.createElement("span", {
    className: "k-ask__banner-tool"
  }, tool)), /*#__PURE__*/React.createElement("div", {
    className: "k-ask__body"
  }, questions.map((q, qi) => {
    const kind = q.kind || "select";
    const multi = !!q.multiSelect;
    return /*#__PURE__*/React.createElement("div", {
      className: "k-ask__q",
      key: qi
    }, /*#__PURE__*/React.createElement("div", {
      className: "k-ask__q-head"
    }, q.header && /*#__PURE__*/React.createElement("span", {
      className: "k-ask__q-eyebrow"
    }, q.header), kind === "select" && multi && /*#__PURE__*/React.createElement("span", {
      className: "k-ask__q-multi"
    }, "select any"), kind === "text" && q.optional && /*#__PURE__*/React.createElement("span", {
      className: "k-ask__q-multi"
    }, "optional")), /*#__PURE__*/React.createElement("div", {
      className: "k-ask__q-text"
    }, q.question), kind === "confirm" ? renderConfirm(q, qi) : kind === "text" ? renderText(q, qi) : renderOptions(q, qi, multi));
  }), !answered && /*#__PURE__*/React.createElement("div", {
    className: "k-ask__foot"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-ask__hint"
  }, "the run is paused on the leash"), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "primary",
    disabled: !complete,
    onClick: submit
  }, "Send answer \xB7 resume"))));
}
Object.assign(__ds_scope, { AskPanel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/run/AskPanel.jsx", error: String((e && e.message) || e) }); }

// components/run/EventRow.jsx
try { (() => {
/**
 * EventRow — one line of the normalized KataEvent stream (right pane).
 * `variant` maps to a KataEvent type; `gutter` is the left rail label.
 */
function EventRow({
  variant = "log",
  gutter,
  tool,
  children,
  className = ""
}) {
  const cls = ["k-event", `k-event--${variant}`, className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: cls
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-event__gutter"
  }, gutter), /*#__PURE__*/React.createElement("span", {
    className: "k-event__body"
  }, tool && /*#__PURE__*/React.createElement("span", {
    className: "k-event__tool"
  }, tool, " "), children));
}
Object.assign(__ds_scope, { EventRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/run/EventRow.jsx", error: String((e && e.message) || e) }); }

// components/run/KitItem.jsx
try { (() => {
/**
 * KitItem — one catalog row in the Kit checklist. Composes Checkbox + Tag.
 * When selected, reveals an optional detail slot (provides / MCP / env).
 */
function KitItem({
  kind = "skill",
  name,
  description,
  selected = false,
  onToggle,
  detail,
  className = ""
}) {
  const cls = ["k-kit", selected && "k-kit--selected", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: cls
  }, /*#__PURE__*/React.createElement("label", {
    className: "k-kit__main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-kit__check"
  }, /*#__PURE__*/React.createElement(__ds_scope.Checkbox, {
    checked: selected,
    onChange: onToggle
  })), /*#__PURE__*/React.createElement(__ds_scope.Tag, {
    kind: kind
  }), /*#__PURE__*/React.createElement("span", {
    className: "k-kit__name"
  }, name), description && /*#__PURE__*/React.createElement("span", {
    className: "k-kit__desc"
  }, description)), selected && detail && /*#__PURE__*/React.createElement("div", {
    className: "k-kit__detail"
  }, detail));
}
Object.assign(__ds_scope, { KitItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/run/KitItem.jsx", error: String((e && e.message) || e) }); }

// components/run/SummaryStat.jsx
try { (() => {
/** SummaryStat — one figure in the run summary card (exit, turns, cost, time). */
function SummaryStat({
  label,
  value,
  tone,
  className = ""
}) {
  const vcls = ["k-stat__value", tone && `k-stat__value--${tone}`].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: ["k-stat", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("span", {
    className: "k-stat__label"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: vcls
  }, value));
}
Object.assign(__ds_scope, { SummaryStat });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/run/SummaryStat.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Kbd = __ds_scope.Kbd;

__ds_ns.StatusDot = __ds_scope.StatusDot;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Field = __ds_scope.Field;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.SegmentedControl = __ds_scope.SegmentedControl;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.TextInput = __ds_scope.TextInput;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.AskPanel = __ds_scope.AskPanel;

__ds_ns.EventRow = __ds_scope.EventRow;

__ds_ns.KitItem = __ds_scope.KitItem;

__ds_ns.SummaryStat = __ds_scope.SummaryStat;

})();
