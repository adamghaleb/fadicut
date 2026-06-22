/* fadiStrobe — Panel Logic & CSInterface Bridge */

(function () {
	"use strict";

	var csInterface = new CSInterface();

	var FRAME_PRESETS = [1, 2, 3, 5, 10];
	var STAGGER_PRESETS = [0, 1, 2, 4, 8];

	// DOM
	var styleSel = document.getElementById("style");
	var onLabel = document.getElementById("onLabel");
	var offLabel = document.getElementById("offLabel");
	var onChips = document.getElementById("onChips");
	var onInput = document.getElementById("onInput");
	var offChips = document.getElementById("offChips");
	var offInput = document.getElementById("offInput");
	var maxOp = document.getElementById("maxOp");
	var maxOpVal = document.getElementById("maxOpVal");
	var minOp = document.getElementById("minOp");
	var minOpVal = document.getElementById("minOpVal");
	var staggerChips = document.getElementById("staggerChips");
	var staggerInput = document.getElementById("staggerInput");
	var matchLayerToggle = document.getElementById("matchLayerToggle");
	var totalDurationRow = document.getElementById("totalDurationRow");
	var totalDuration = document.getElementById("totalDuration");
	var applyBtn = document.getElementById("applyBtn");
	var statusEl = document.getElementById("status");
	var previewHint = document.getElementById("previewHint");
	var canvas = document.getElementById("preview");
	var ctx = canvas.getContext("2d");

	// ---- Chip Controls ----

	function buildChips(container, input, presets, min) {
		presets.forEach(function (val) {
			var chip = document.createElement("div");
			chip.className = "chip";
			chip.textContent = val;
			if (parseInt(input.value, 10) === val) chip.classList.add("active");

			chip.addEventListener("click", function () {
				input.value = val;
				highlightChips(container, val);
				drawPreview();
			});

			container.appendChild(chip);
		});

		input.addEventListener("blur", function () {
			var v = parseInt(input.value, 10);
			if (isNaN(v) || v < min) v = min;
			if (v > 60) v = 60;
			input.value = v;
			highlightChips(container, v);
			drawPreview();
		});

		input.addEventListener("input", function () {
			highlightChips(container, parseInt(input.value, 10));
			drawPreview();
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

	buildChips(onChips, onInput, FRAME_PRESETS, 1);
	buildChips(offChips, offInput, FRAME_PRESETS, 0);
	buildChips(staggerChips, staggerInput, STAGGER_PRESETS, 0);

	// ---- Sliders ----

	maxOp.addEventListener("input", function () {
		maxOpVal.textContent = maxOp.value;
		drawPreview();
	});
	minOp.addEventListener("input", function () {
		minOpVal.textContent = minOp.value;
		drawPreview();
	});

	// ---- Style label hints ----

	styleSel.addEventListener("change", function () {
		var wave = styleSel.value === "pulse" || styleSel.value === "triangle";
		// For wave styles, On = rise, Off = fall portion of each cycle
		onLabel.textContent = wave ? "Rise" : "On";
		offLabel.textContent = wave ? "Fall" : "Off";
		drawPreview();
	});

	// ---- Output toggle ----

	matchLayerToggle.addEventListener("change", function () {
		totalDurationRow.classList.toggle("hidden", matchLayerToggle.checked);
	});

	// ---- Live waveform preview ----
	// Mirrors the ExtendScript math so the canvas == what gets applied.

	function strobeValueAt(frame, style, on, off, lo, hi) {
		var period = on + off;
		if (period < 1) period = 1;
		if (style === "hard") {
			return frame % period < on ? hi : lo;
		}
		if (style === "flicker") {
			// visual approximation — random level held per cycle
			return lo + (hi - lo) * (0.5 + 0.4 * Math.sin(frame * 12.9898));
		}
		var pos = (frame % period) / period; // 0..1
		var amp = hi - lo;
		if (style === "pulse") {
			return lo + amp * (0.5 - 0.5 * Math.cos(pos * Math.PI * 2));
		}
		// triangle
		return lo + amp * (1 - Math.abs(2 * pos - 1));
	}

	function drawPreview() {
		var w = canvas.width;
		var h = canvas.height;
		var style = styleSel.value;
		var on = parseInt(onInput.value, 10) || 1;
		var off = parseInt(offInput.value, 10) || 0;
		var lo = parseInt(minOp.value, 10);
		var hi = parseInt(maxOp.value, 10);
		var period = Math.max(1, on + off);

		ctx.clearRect(0, 0, w, h);

		// baseline
		ctx.strokeStyle = "#3e3e3e";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, h - 1);
		ctx.lineTo(w, h - 1);
		ctx.stroke();

		// show ~6 cycles across the strip
		var totalFrames = period * 6;
		var pad = 3;
		var usableH = h - pad * 2;

		ctx.strokeStyle = "#ff0060";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		for (var px = 0; px <= w; px++) {
			var frame = (px / w) * totalFrames;
			var v = strobeValueAt(frame, style, on, off, lo, hi); // 0..100
			var y = pad + (1 - v / 100) * usableH;
			if (px === 0) ctx.moveTo(px, y);
			else ctx.lineTo(px, y);
		}
		ctx.stroke();

		var fps = 24;
		previewHint.textContent =
			"cycle " + period + "f ≈ " + (period / fps).toFixed(2) + "s @ 24fps";
	}

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
		var hi = parseInt(maxOp.value, 10);
		var lo = parseInt(minOp.value, 10);
		if (lo > hi) {
			var t = lo;
			lo = hi;
			hi = t;
		}

		var settings = {
			style: styleSel.value,
			onFrames: parseInt(onInput.value, 10),
			offFrames: parseInt(offInput.value, 10),
			maxOpacity: hi,
			minOpacity: lo,
			stagger: parseInt(staggerInput.value, 10),
			matchLayer: matchLayerToggle.checked ? 1 : 0,
			totalDuration: parseFloat(totalDuration.value),
		};

		applyBtn.disabled = true;
		setStatus("Strobing...", "");

		var script =
			"fadiStrobe_apply('" +
			JSON.stringify(settings).replace(/'/g, "\\'") +
			"')";

		csInterface.evalScript(script, function (result) {
			applyBtn.disabled = false;
			if (result && result.indexOf("ERROR") === 0) {
				setStatus(result, "error");
			} else {
				setStatus(result || "Done!", "success");
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

	drawPreview();
})();
