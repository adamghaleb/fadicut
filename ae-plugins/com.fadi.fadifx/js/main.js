/* fadiFX — Panel Logic & CSInterface Bridge */

(function () {
	"use strict";

	var csInterface = new CSInterface();

	// Canonical order (for "Ordered" reset)
	var CANONICAL = [
		{ name: "Hot Pink", hex: "#ff0060" },
		{ name: "Orange", hex: "#ffa405" },
		{ name: "Yellow", hex: "#ffe400" },
		{ name: "Neon Green", hex: "#11ff05" },
		{ name: "Electric Cyan", hex: "#05d3ff" },
		{ name: "Purple", hex: "#6f05ff" },
		{ name: "Magenta", hex: "#f605ff" },
	];

	// Working color array — this IS the cycle order (left to right = play order)
	var fadiColors = CANONICAL.map(function (c) {
		return { name: c.name, hex: c.hex };
	});

	var FRAME_PRESETS = [1, 2, 3, 5, 10];
	var isCustomMode = false;
	var isReversed = false; // tracks if array is currently reversed

	// DOM
	var colorRow = document.getElementById("colorRow");
	var orderedBtn = document.getElementById("orderedBtn");
	var customBtn = document.getElementById("customBtn");
	var frameChips = document.getElementById("frameChips");
	var frameInput = document.getElementById("frameInput");
	var strobeToggle = document.getElementById("strobeToggle");
	var strobeGapRow = document.getElementById("strobeGapRow");
	var strobeChips = document.getElementById("strobeChips");
	var strobeInput = document.getElementById("strobeInput");
	var direction = document.getElementById("direction");
	var waveformMode = document.getElementById("waveformMode");
	var pulseSpeedRow = document.getElementById("pulseSpeedRow");
	var pulseSpeed = document.getElementById("pulseSpeed");
	var pulseSpeedVal = document.getElementById("pulseSpeedVal");
	var applyMode = document.getElementById("applyMode");
	var matchLayerToggle = document.getElementById("matchLayerToggle");
	var totalDurationRow = document.getElementById("totalDurationRow");
	var totalDuration = document.getElementById("totalDuration");
	var applyBtn = document.getElementById("applyBtn");
	var statusEl = document.getElementById("status");

	// ---- Color Swatches ----

	var dragSrcIndex = null;

	function renderSwatches() {
		while (colorRow.firstChild) colorRow.removeChild(colorRow.firstChild);

		fadiColors.forEach(function (color, i) {
			var el = document.createElement("div");
			// First swatch = start color (highlighted)
			el.className = "swatch" + (i === 0 ? " start" : "");
			el.style.backgroundColor = color.hex;
			el.title = color.name + (i === 0 ? " (start)" : "");
			el.draggable = isCustomMode;

			// Click to set as start color — rotate array
			el.addEventListener("click", function () {
				if (i === 0) return; // already start
				var head = fadiColors.slice(0, i);
				var tail = fadiColors.slice(i);
				fadiColors = tail.concat(head);
				renderSwatches();
			});

			// Drag to reorder (custom mode only)
			if (isCustomMode) {
				el.addEventListener("dragstart", function (e) {
					dragSrcIndex = i;
					el.classList.add("dragging");
					e.dataTransfer.effectAllowed = "move";
					// Set drag image to a colored square
					var ghost = document.createElement("div");
					ghost.style.width = "24px";
					ghost.style.height = "24px";
					ghost.style.borderRadius = "3px";
					ghost.style.backgroundColor = color.hex;
					ghost.style.position = "fixed";
					ghost.style.top = "-100px";
					document.body.appendChild(ghost);
					e.dataTransfer.setDragImage(ghost, 12, 12);
					setTimeout(function () {
						document.body.removeChild(ghost);
					}, 0);
				});

				el.addEventListener("dragend", function () {
					el.classList.remove("dragging");
					// Clear all drag-over states
					var swatches = colorRow.children;
					for (var j = 0; j < swatches.length; j++) {
						swatches[j].classList.remove("drag-over");
					}
					dragSrcIndex = null;
				});

				el.addEventListener("dragover", function (e) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					if (dragSrcIndex !== null && dragSrcIndex !== i) {
						el.classList.add("drag-over");
					}
				});

				el.addEventListener("dragleave", function () {
					el.classList.remove("drag-over");
				});

				el.addEventListener("drop", function (e) {
					e.preventDefault();
					el.classList.remove("drag-over");
					if (dragSrcIndex !== null && dragSrcIndex !== i) {
						var moved = fadiColors.splice(dragSrcIndex, 1)[0];
						fadiColors.splice(i, 0, moved);
						renderSwatches();
					}
				});
			}

			colorRow.appendChild(el);
		});
	}

	renderSwatches();

	// ---- Ordered / Custom mode ----

	function setMode(custom) {
		isCustomMode = custom;
		orderedBtn.classList.toggle("active", !custom);
		customBtn.classList.toggle("active", custom);

		if (!custom) {
			// Reset to canonical order, respecting current direction
			fadiColors = CANONICAL.map(function (c) {
				return { name: c.name, hex: c.hex };
			});
			if (isReversed) fadiColors.reverse();
		}

		renderSwatches();
	}

	orderedBtn.addEventListener("click", function () {
		setMode(false);
	});
	customBtn.addEventListener("click", function () {
		setMode(true);
	});

	// ---- Direction ----
	// Switching forward <-> reverse flips the swatch display order

	direction.addEventListener("change", function () {
		var wantReversed = direction.value === "reverse";

		if (wantReversed && !isReversed) {
			fadiColors.reverse();
			isReversed = true;
		} else if (!wantReversed && isReversed) {
			fadiColors.reverse();
			isReversed = false;
		}

		renderSwatches();
	});

	// ---- Chip Controls ----

	function buildChips(container, input, presets) {
		presets.forEach(function (val) {
			var chip = document.createElement("div");
			chip.className = "chip";
			chip.textContent = val;
			if (parseInt(input.value, 10) === val) chip.classList.add("active");

			chip.addEventListener("click", function () {
				input.value = val;
				highlightChips(container, val);
			});

			container.appendChild(chip);
		});

		input.addEventListener("blur", function () {
			var v = parseInt(input.value, 10);
			if (isNaN(v) || v < 1) v = 1;
			if (v > 60) v = 60;
			var nearest = presets[0];
			var minDist = Math.abs(v - nearest);
			for (var i = 1; i < presets.length; i++) {
				var dist = Math.abs(v - presets[i]);
				if (dist < minDist) {
					minDist = dist;
					nearest = presets[i];
				}
			}
			input.value = nearest;
			highlightChips(container, nearest);
		});

		input.addEventListener("input", function () {
			highlightChips(container, parseInt(input.value, 10));
		});
	}

	function highlightChips(container, val) {
		var chips = container.children;
		for (var i = 0; i < chips.length; i++) {
			if (parseInt(chips[i].textContent, 10) === val) {
				chips[i].classList.add("active");
			} else {
				chips[i].classList.remove("active");
			}
		}
	}

	buildChips(frameChips, frameInput, FRAME_PRESETS);
	buildChips(strobeChips, strobeInput, FRAME_PRESETS);

	// ---- Slider ----

	pulseSpeed.addEventListener("input", function () {
		pulseSpeedVal.textContent = pulseSpeed.value;
	});

	// ---- Visibility toggles ----

	strobeToggle.addEventListener("change", function () {
		strobeGapRow.classList.toggle("hidden", !strobeToggle.checked);
	});

	waveformMode.addEventListener("change", function () {
		pulseSpeedRow.classList.toggle("hidden", waveformMode.value === "off");
	});

	matchLayerToggle.addEventListener("change", function () {
		totalDurationRow.classList.toggle("hidden", matchLayerToggle.checked);
	});

	// ---- Status ----

	function setStatus(msg, type) {
		statusEl.textContent = msg;
		statusEl.className = "status" + (type ? " " + type : "");
		if (type === "success") {
			setTimeout(function () {
				statusEl.textContent = "";
				statusEl.className = "status";
			}, 3000);
		}
	}

	// ---- Apply ----

	applyBtn.addEventListener("click", function () {
		// Colors are always sent in display order.
		// For reverse, array is already reversed, so tell ExtendScript "forward".
		// For ping-pong, array is in forward order, send "pingpong".
		var effectiveDir = direction.value === "pingpong" ? "pingpong" : "forward";

		var settings = {
			colors: fadiColors.map(function (c) {
				return c.hex;
			}),
			frameDuration: parseInt(frameInput.value, 10),
			strobeOn: strobeToggle.checked ? 1 : 0,
			strobeGap: parseInt(strobeInput.value, 10),
			direction: effectiveDir,
			waveformMode: waveformMode.value,
			pulseSpeed: parseInt(pulseSpeed.value, 10),
			applyMode: applyMode.value,
			matchLayer: matchLayerToggle.checked ? 1 : 0,
			totalDuration: parseFloat(totalDuration.value),
		};

		applyBtn.disabled = true;
		setStatus("Applying...", "");

		var script =
			"fadiFX_apply('" + JSON.stringify(settings).replace(/'/g, "\\'") + "')";

		csInterface.evalScript(script, function (result) {
			applyBtn.disabled = false;
			if (result && result.indexOf("ERROR") === 0) {
				setStatus(result, "error");
			} else {
				setStatus(result || "Applied!", "success");
			}
		});
	});

	// ---- Theme sync ----

	function updateThemeColor() {
		var hostEnv = csInterface.getHostEnvironment();
		if (hostEnv && hostEnv.appSkinInfo) {
			var bg = hostEnv.appSkinInfo.panelBackgroundColor.color;
			var r = Math.round(bg.red);
			var g = Math.round(bg.green);
			var b = Math.round(bg.blue);
			document.body.style.background = "rgb(" + r + "," + g + "," + b + ")";
		}
	}
	csInterface.addEventListener(
		"com.adobe.csxs.events.ThemeColorChanged",
		updateThemeColor,
	);
	updateThemeColor();
})();
