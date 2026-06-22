/* fadiRange — Panel Logic, WebGL preview clock & CSInterface bridge */

(function () {
	"use strict";

	var csInterface = new CSInterface();

	var FADI = [
		"#ff0060",
		"#ffa405",
		"#ffe400",
		"#11ff05",
		"#05d3ff",
		"#6f05ff",
		"#f605ff",
	];
	var FRAME_PRESETS = [1, 2, 3, 5, 10];

	function hexToRGB(hex) {
		hex = hex.replace("#", "");
		return [
			parseInt(hex.substring(0, 2), 16) / 255,
			parseInt(hex.substring(2, 4), 16) / 255,
			parseInt(hex.substring(4, 6), 16) / 255,
		];
	}
	function rgbToHex(c) {
		function h(v) {
			var s = Math.round(v * 255).toString(16);
			return s.length === 1 ? "0" + s : s;
		}
		return "#" + h(c[0]) + h(c[1]) + h(c[2]);
	}

	// ---- DOM ----
	var canvas = document.getElementById("previewCanvas");
	var previewEmpty = document.getElementById("previewEmpty");
	var grabBtn = document.getElementById("grabBtn");
	var playBtn = document.getElementById("playBtn");
	var modeSeg = document.getElementById("modeSeg");
	var targetRow = document.getElementById("targetRow");
	var targetChip = document.getElementById("targetChip");
	var lumaLoRow = document.getElementById("lumaLoRow");
	var lumaHiRow = document.getElementById("lumaHiRow");
	var tolRow = document.getElementById("tolRow");
	var featherRow = document.getElementById("featherRow");
	var lumaLo = document.getElementById("lumaLo");
	var lumaHi = document.getElementById("lumaHi");
	var tol = document.getElementById("tol");
	var feather = document.getElementById("feather");
	var presetGrid = document.getElementById("presetGrid");
	var mosaicRow = document.getElementById("mosaicRow");
	var posterRow = document.getElementById("posterRow");
	var mosaic = document.getElementById("mosaic");
	var poster = document.getElementById("poster");
	var thresholdRow = document.getElementById("thresholdRow");
	var threshold = document.getElementById("threshold");
	var duoColorRow = document.getElementById("duoColorRow");
	var duoSwatches = document.getElementById("duoSwatches");
	var modSeg = document.getElementById("modSeg");
	var onRow = document.getElementById("onRow");
	var offRow = document.getElementById("offRow");
	var onLabel = document.getElementById("onLabel");
	var offLabel = document.getElementById("offLabel");
	var onChips = document.getElementById("onChips");
	var offChips = document.getElementById("offChips");
	var onInput = document.getElementById("onInput");
	var offInput = document.getElementById("offInput");
	var spanSel = document.getElementById("span");
	var customSpanRow = document.getElementById("customSpanRow");
	var tStart = document.getElementById("tStart");
	var tEnd = document.getElementById("tEnd");
	var applyBtn = document.getElementById("applyBtn");
	var statusEl = document.getElementById("status");

	// ---- State ----
	var state = {
		mode: 0,
		preset: 0,
		mod: "static",
		target: hexToRGB("#ff0060"),
		duoColor: hexToRGB("#ff0060"),
	};

	// ---- WebGL preview ----
	var preview = null;
	try {
		preview = new FadiPreview(canvas);
		preview.set({ fadi: FADI.map(hexToRGB) });
	} catch (e) {
		previewEmpty.textContent = "WebGL error: " + e.message;
	}

	function pushPreviewParams() {
		if (!preview) return;
		preview.set({
			mode: state.mode,
			lo: parseInt(lumaLo.value, 10) / 100,
			hi: parseInt(lumaHi.value, 10) / 100,
			feather: parseInt(feather.value, 10) / 100,
			target: state.target,
			tol: parseInt(tol.value, 10) / 100,
			preset: state.preset,
			mosaic: parseInt(mosaic.value, 10),
			poster: parseInt(poster.value, 10),
			threshold: parseInt(threshold.value, 10) / 100,
			duoColor: state.duoColor,
		});
	}

	// ---- Segmented groups ----
	function wireSeg(container, attr, onPick) {
		container.addEventListener("click", function (e) {
			var btn = e.target.closest ? e.target.closest("button") : null;
			if (!btn) return;
			var kids = container.querySelectorAll("button");
			for (var i = 0; i < kids.length; i++) kids[i].classList.remove("active");
			btn.classList.add("active");
			onPick(btn.getAttribute(attr));
		});
	}

	wireSeg(modeSeg, "data-mode", function (v) {
		state.mode = parseInt(v, 10);
		updateRangeVisibility();
		pushPreviewParams();
	});

	wireSeg(presetGrid, "data-preset", function (v) {
		state.preset = parseInt(v, 10);
		mosaicRow.classList.toggle("hidden", state.preset !== 3);
		posterRow.classList.toggle("hidden", state.preset !== 4);
		// threshold slider for Threshold + both duotones (6,7,8)
		thresholdRow.classList.toggle("hidden", state.preset < 6);
		// fadi color picker only for the duotones (7,8)
		duoColorRow.classList.toggle(
			"hidden",
			state.preset !== 7 && state.preset !== 8,
		);
		pushPreviewParams();
	});

	wireSeg(modSeg, "data-mod", function (v) {
		state.mod = v;
		updateModVisibility();
	});

	function updateRangeVisibility() {
		var isLuma = state.mode === 1;
		var isColor = state.mode === 2;
		lumaLoRow.classList.toggle("hidden", !isLuma);
		lumaHiRow.classList.toggle("hidden", !isLuma);
		tolRow.classList.toggle("hidden", !isColor);
		targetRow.classList.toggle("hidden", !isColor);
		featherRow.classList.toggle("hidden", !(isLuma || isColor));
	}

	function updateModVisibility() {
		var isStatic = state.mod === "static";
		onRow.classList.toggle("hidden", isStatic);
		offRow.classList.toggle("hidden", isStatic);
		if (state.mod === "cycle") {
			onLabel.textContent = "Hold";
			offLabel.textContent = "—";
			offRow.classList.add("hidden");
		} else if (state.mod === "pulse") {
			onLabel.textContent = "Rise";
			offLabel.textContent = "Fall";
		} else {
			onLabel.textContent = "On";
			offLabel.textContent = "Off";
		}
	}

	// ---- Sliders ----
	function wireSlider(el, valEl) {
		el.addEventListener("input", function () {
			valEl.textContent = el.value;
			pushPreviewParams();
		});
	}
	wireSlider(lumaLo, document.getElementById("lumaLoVal"));
	wireSlider(lumaHi, document.getElementById("lumaHiVal"));
	wireSlider(tol, document.getElementById("tolVal"));
	wireSlider(feather, document.getElementById("featherVal"));
	wireSlider(mosaic, document.getElementById("mosaicVal"));
	wireSlider(poster, document.getElementById("posterVal"));
	wireSlider(threshold, document.getElementById("thresholdVal"));

	// ---- Duotone fadi-color picker ----
	FADI.forEach(function (hex, i) {
		var sw = document.createElement("div");
		sw.className = "swatch" + (i === 0 ? " start" : "");
		sw.style.backgroundColor = hex;
		sw.title = hex;
		sw.addEventListener("click", function () {
			state.duoColor = hexToRGB(hex);
			var kids = duoSwatches.children;
			for (var j = 0; j < kids.length; j++) kids[j].classList.remove("start");
			sw.classList.add("start");
			pushPreviewParams();
		});
		duoSwatches.appendChild(sw);
	});

	// ---- Chips ----
	function buildChips(container, input, presets, min) {
		presets.forEach(function (val) {
			var chip = document.createElement("div");
			chip.className = "chip";
			chip.textContent = val;
			if (parseInt(input.value, 10) === val) chip.classList.add("active");
			chip.addEventListener("click", function () {
				input.value = val;
				highlight(container, val);
			});
			container.appendChild(chip);
		});
		input.addEventListener("input", function () {
			highlight(container, parseInt(input.value, 10));
		});
		input.addEventListener("blur", function () {
			var v = parseInt(input.value, 10);
			if (isNaN(v) || v < min) v = min;
			if (v > 60) v = 60;
			input.value = v;
			highlight(container, v);
		});
	}
	function highlight(container, val) {
		var c = container.children;
		for (var i = 0; i < c.length; i++) {
			c[i].classList.toggle("active", parseInt(c[i].textContent, 10) === val);
		}
	}
	buildChips(onChips, onInput, FRAME_PRESETS, 1);
	buildChips(offChips, offInput, FRAME_PRESETS, 0);

	// ---- Span ----
	spanSel.addEventListener("change", function () {
		customSpanRow.classList.toggle("hidden", spanSel.value !== "custom");
	});

	// ---- Eyedropper: click preview to pick color target ----
	canvas.addEventListener("click", function (e) {
		if (!preview || !preview.hasImage || state.mode !== 2) return;
		var rect = canvas.getBoundingClientRect();
		var nx = (e.clientX - rect.left) / rect.width;
		var ny = (e.clientY - rect.top) / rect.height;
		var c = preview.pickColorAt(nx, ny);
		state.target = c;
		var hex = rgbToHex(c);
		targetChip.style.background = hex;
		pushPreviewParams();
	});

	// ---- Modulation clock (drives the live preview) ----
	var playing = false;
	var clockFrame = 0;
	var lastTs = 0;
	var FPS = 24;

	function modAmount(frame) {
		var on = parseInt(onInput.value, 10) || 1;
		var off = parseInt(offInput.value, 10) || 0;
		var period = Math.max(1, on + off);
		var pos = (frame % period) / period;
		switch (state.mod) {
			case "strobe":
				return frame % period < on ? 1 : 0;
			case "pulse":
				return 0.5 - 0.5 * Math.cos(pos * Math.PI * 2);
			case "flicker":
				return 0.4 + 0.6 * Math.abs(Math.sin(frame * 12.9898));
			case "cycle":
				return 1;
			default:
				return 1;
		}
	}
	function modPhase(frame) {
		if (state.mod !== "cycle") return 0;
		var hold = parseInt(onInput.value, 10) || 3;
		var idx = Math.floor(frame / Math.max(1, hold)) % 7;
		return idx / 6;
	}

	function loop(ts) {
		if (!playing) return;
		if (!lastTs) lastTs = ts;
		var dt = (ts - lastTs) / 1000;
		lastTs = ts;
		clockFrame += dt * FPS;
		if (preview && preview.hasImage) {
			preview.set({
				amount: modAmount(clockFrame),
				phase: modPhase(clockFrame),
			});
		}
		requestAnimationFrame(loop);
	}

	playBtn.addEventListener("click", function () {
		playing = !playing;
		playBtn.classList.toggle("active", playing);
		playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
		if (playing) {
			lastTs = 0;
			requestAnimationFrame(loop);
		} else if (preview) {
			preview.set({ amount: 1, phase: 0 }); // settle on full effect
		}
	});

	// ---- Grab frame from AE ----
	// Node's fs is required so we can read the PNG bytes and load them as a base64
	// data URL. file:// URLs are unreliable in CEF (query strings don't strip,
	// file-access can be blocked, and canvas can be tainted), so we avoid them.
	function nodeRequire(mod) {
		if (typeof window.cep_node !== "undefined" && window.cep_node.require) {
			return window.cep_node.require(mod);
		}
		if (typeof window.require === "function") return window.require(mod);
		return null;
	}

	function loadImageFromPath(path) {
		var img = new Image();
		img.onload = function () {
			previewEmpty.style.display = "none";
			if (preview) {
				preview.setImage(img);
				pushPreviewParams();
			}
			setStatus("Frame loaded", "success");
		};
		img.onerror = function () {
			setStatus("ERROR: png decode failed", "error");
		};

		// Preferred: read bytes via Node and inline as a data URL
		try {
			var fs = nodeRequire("fs");
			if (fs && fs.readFileSync) {
				var b64 = fs.readFileSync(path).toString("base64");
				img.src = "data:image/png;base64," + b64;
				return;
			}
		} catch (e) {
			setStatus("ERROR: read failed — " + e.message, "error");
		}

		// Fallback: file:// (no query string)
		img.src = "file://" + path.split(" ").join("%20");
	}

	grabBtn.addEventListener("click", function () {
		setStatus("Grabbing frame...", "");
		csInterface.evalScript("fadiRange_grabFrame()", function (result) {
			if (!result || result === "EvalScript error.") {
				setStatus("ERROR: ExtendScript failed (check AE version)", "error");
				return;
			}
			if (result.indexOf("ERROR") === 0) {
				setStatus(result, "error");
				return;
			}
			loadImageFromPath(result);
		});
	});

	// ---- Status ----
	function setStatus(msg, type) {
		statusEl.textContent = msg;
		statusEl.className = "status" + (type ? " " + type : "");
		if (type === "success") {
			setTimeout(function () {
				statusEl.textContent = "";
				statusEl.className = "status";
			}, 2500);
		}
	}

	// ---- Apply ----
	applyBtn.addEventListener("click", function () {
		var settings = {
			mode: state.mode, // 0 whole, 1 luma, 2 color
			preset: state.preset, // 0..5
			modulation: state.mod,
			onFrames: parseInt(onInput.value, 10),
			offFrames: parseInt(offInput.value, 10),
			lumaLo: parseInt(lumaLo.value, 10) / 100,
			lumaHi: parseInt(lumaHi.value, 10) / 100,
			feather: parseInt(feather.value, 10) / 100,
			target: state.target, // 0..1 rgb
			tolerance: parseInt(tol.value, 10) / 100,
			mosaic: parseInt(mosaic.value, 10),
			poster: parseInt(poster.value, 10),
			threshold: parseInt(threshold.value, 10) / 100,
			duoColor: state.duoColor,
			fadi: FADI,
			span: spanSel.value, // layer | work | custom
			tStart: parseFloat(tStart.value),
			tEnd: parseFloat(tEnd.value),
		};

		applyBtn.disabled = true;
		setStatus("Applying...", "");
		var script =
			"fadiRange_apply('" +
			JSON.stringify(settings).replace(/'/g, "\\'") +
			"')";
		csInterface.evalScript(script, function (result) {
			applyBtn.disabled = false;
			if (result && result.indexOf("ERROR") === 0) setStatus(result, "error");
			else setStatus(result || "Applied!", "success");
		});
	});

	// ---- Theme sync ----
	function updateTheme() {
		var env = csInterface.getHostEnvironment();
		if (env && env.appSkinInfo) {
			var bg = env.appSkinInfo.panelBackgroundColor.color;
			document.body.style.background =
				"rgb(" +
				Math.round(bg.red) +
				"," +
				Math.round(bg.green) +
				"," +
				Math.round(bg.blue) +
				")";
		}
	}
	csInterface.addEventListener(
		"com.adobe.csxs.events.ThemeColorChanged",
		updateTheme,
	);
	updateTheme();

	// init
	updateRangeVisibility();
	updateModVisibility();
})();
