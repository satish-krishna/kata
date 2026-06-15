/* Kata Workbench — Lucide-style icon set (1.5–2px stroke, currentColor).
   These mirror the Lucide names documented in the design system's
   ICONOGRAPHY section. Exposed on window for the babel-scoped app files. */
(function () {
  const P = (d, extra) =>
    React.createElement("svg", Object.assign({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }, extra),
      Array.isArray(d) ? d.map((dd, i) => React.createElement("path", { key: i, d: dd })) : React.createElement("path", { d }));

  const PATHS = {
    "file-plus": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6",
    "folder-open": "M6 14l1.5-3.5a2 2 0 0 1 1.8-1.2H21a1 1 0 0 1 1 1.3L20 19a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2",
    "folder": "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
    "save": "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8",
    "package": "M16.5 9.4 7.5 4.2M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12",
    "play": "M6 3l14 9-14 9z",
    "square": "M5 5h14v14H5z",
    "search": "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
    "git-branch": "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM15 6a9 9 0 0 1-9 9",
    "terminal": "M4 17l6-6-6-6M12 19h8",
    "clock": ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
    "coins": ["M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z", "M18.1 8.6a6 6 0 1 1-9 7.4", "M7 6h1v4", "M16.7 14H18v4"],
    "hash": "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
    "alert-triangle": ["M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"],
    "check-circle": ["M22 11.1V12a10 10 0 1 1-5.9-9.1", "M22 4 12 14.2l-3-3"],
    "x-circle": ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M15 9l-6 6M9 9l6 6"],
    "cpu": ["M6 6h12v12H6z", "M9 9h6v6H9z", "M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"],
  };

  function Icon({ name, size = 16, ...rest }) {
    const d = PATHS[name];
    if (!d) return null;
    return P(d, Object.assign({ width: size, height: size }, rest));
  }
  window.WBIcon = Icon;
})();
