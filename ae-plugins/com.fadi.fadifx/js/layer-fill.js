/* fadiFX — Static fills for the current AE layer selection. */
(function () {
	"use strict";

	window.FadiLayerFill = function (options) {
		var fillButton = document.getElementById("fillLayersMode");
		var animateButton = document.getElementById("animateMode");
		var orderedButton = document.getElementById("orderedBtn");
		var dropTarget = document.getElementById("fillDropTarget");
		var mode = "fill";
		var busy = false;
		var activeDrag = null;
		var suppressClickUntil = 0;
		var dragType = "application/x-fadifx-layer-fill";
		var storageKey = "fadiFX.operationMode";
		var orderedTitle =
			"Apply enabled palette colors to selected layers, top to bottom. Repeat after the last color. Drag to the selected-layers box below.";

		try {
			if (window.localStorage.getItem(storageKey) === "animate")
				mode = "animate";
		} catch (error) {
			/* CEP may disable local storage. */
		}

		function updateMode() {
			var filling = mode === "fill";
			document.body.classList.toggle("layer-fill-mode", filling);
			fillButton.setAttribute("aria-pressed", String(filling));
			animateButton.setAttribute("aria-pressed", String(!filling));
			orderedButton.draggable = filling;
			orderedButton.title = filling
				? orderedTitle
				: "Reset to the original palette order";
		}

		function changeMode(nextMode) {
			mode = nextMode;
			clearDrag();
			updateMode();
			try {
				window.localStorage.setItem(storageKey, mode);
			} catch (error) {}
			options.onModeChange();
		}

		function settingsFor(action, colors) {
			if (!colors.length || (action !== "single" && action !== "ordered"))
				return null;
			for (var i = 0; i < colors.length; i++) {
				if (!/^#[0-9a-f]{6}$/i.test(colors[i])) return null;
			}
			return { mode: action, colors: colors.slice() };
		}

		function apply(settings) {
			if (mode !== "fill" || busy || !settings) return;
			busy = true;
			document.body.classList.add("fill-busy");
			orderedButton.setAttribute("aria-disabled", "true");
			options.setStatus("Applying Fill to selected layers...", "");
			function finish(result) {
				busy = false;
				document.body.classList.remove("fill-busy");
				orderedButton.removeAttribute("aria-disabled");
				if (!result || /^ERROR|EvalScript error/i.test(result)) {
					options.setStatus(
						result || "ERROR: AE did not confirm the Fill. Try again.",
						"error",
					);
				} else {
					options.setStatus(result, "success");
				}
			}
			try {
				options.bridge.evalScript(
					"fadiFX_applyLayerFill(" +
						JSON.stringify(JSON.stringify(settings)) +
						")",
					finish,
				);
			} catch (error) {
				finish("ERROR: " + error.message);
			}
		}

		function clearDrag() {
			if (activeDrag) activeDrag.element.classList.remove("dragging");
			activeDrag = null;
			dropTarget.classList.remove("drag-over");
		}

		function bindDrag(element, getSettings) {
			element.addEventListener("dragstart", function (event) {
				var settings = getSettings();
				if (mode !== "fill" || busy || !settings) {
					event.preventDefault();
					return;
				}
				var payload = JSON.stringify({
					token: Date.now() + ":" + Math.random(),
					settings: settings,
				});
				activeDrag = { element: element, payload: payload, settings: settings };
				event.dataTransfer.effectAllowed = "copy";
				event.dataTransfer.setData(dragType, payload);
				element.classList.add("dragging");
			});
			element.addEventListener("dragend", function () {
				suppressClickUntil = Date.now() + 350;
				clearDrag();
			});
		}

		dropTarget.addEventListener("dragover", function (event) {
			if (!activeDrag || busy || mode !== "fill") return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			dropTarget.classList.add("drag-over");
		});
		dropTarget.addEventListener("dragleave", function () {
			dropTarget.classList.remove("drag-over");
		});
		dropTarget.addEventListener("drop", function (event) {
			event.preventDefault();
			var drag = activeDrag;
			clearDrag();
			if (!drag || event.dataTransfer.getData(dragType) !== drag.payload)
				return;
			suppressClickUntil = Date.now() + 350;
			apply(drag.settings);
		});
		document.addEventListener("keydown", function (event) {
			if (event.key === "Escape") clearDrag();
		});

		fillButton.addEventListener("click", function () {
			changeMode("fill");
		});
		animateButton.addEventListener("click", function () {
			changeMode("animate");
		});
		bindDrag(orderedButton, function () {
			return settingsFor("ordered", options.getColors());
		});
		updateMode();

		this.isActive = function () {
			return mode === "fill";
		};
		this.applyOrdered = function () {
			if (Date.now() >= suppressClickUntil)
				apply(settingsFor("ordered", options.getColors()));
		};
		this.bindSwatch = function (element, color, toggleColor) {
			element.draggable = true;
			element.title =
				color.name +
				" (" +
				color.hex +
				") — Fill every selected layer. Drag to the box below. Alt-click / right-click to " +
				(color.enabled ? "exclude from" : "include in") +
				" Ordered.";
			element.setAttribute("aria-label", element.title);
			element.addEventListener("click", function (event) {
				if (Date.now() < suppressClickUntil || busy) return;
				if (event.altKey) toggleColor();
				else apply(settingsFor("single", [color.hex]));
			});
			element.addEventListener("contextmenu", function (event) {
				event.preventDefault();
				if (!busy) toggleColor();
			});
			bindDrag(element, function () {
				return settingsFor("single", [color.hex]);
			});
		};
	};
})();
