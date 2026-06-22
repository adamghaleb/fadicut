/* fadiRange — ExtendScript host: frame grab + native effect baker */
/* ExtendScript is ES3 — no JSON.parse; eval is the standard controlled pattern */

// ---------- Frame grab (solo selected layer, save current frame to PNG) ----------
function fadiRange_grabFrame() {
	try {
		var comp = app.project.activeItem;
		if (!comp || !(comp instanceof CompItem))
			return "ERROR: No active composition";
		var layers = comp.selectedLayers;
		if (layers.length === 0) return "ERROR: No layers selected";
		var target = layers[0];

		// remember + apply solo so the PNG shows just this layer
		var prevSolo = [];
		for (var i = 1; i <= comp.numLayers; i++) prevSolo.push(comp.layer(i).solo);
		for (var j = 1; j <= comp.numLayers; j++)
			comp.layer(j).solo = comp.layer(j) === target;

		var out = new File(Folder.temp.fsName + "/fadirange_preview.png");
		comp.saveFrameToPng(comp.time, out);

		for (var k = 1; k <= comp.numLayers; k++)
			comp.layer(k).solo = prevSolo[k - 1];

		return out.fsName;
	} catch (e) {
		return "ERROR: " + e.toString();
	}
}

// ---------- Apply ----------
function fadiRange_apply(settingsJSON) {
	try {
		var s = eval("(" + settingsJSON + ")");
		var comp = app.project.activeItem;
		if (!comp || !(comp instanceof CompItem))
			return "ERROR: No active composition";
		var layers = comp.selectedLayers;
		if (layers.length === 0) return "ERROR: No layers selected";
		var fps = comp.frameRate;

		app.beginUndoGroup("fadiRange Apply");
		var count = 0;
		for (var li = 0; li < layers.length; li++) {
			applyToLayer(comp, layers[li], s, fps);
			count++;
		}
		app.endUndoGroup();
		return "Applied to " + count + " layer(s)";
	} catch (e) {
		return "ERROR: " + e.toString();
	}
}

function timeSpan(comp, layer, s, fps) {
	var t0, t1;
	if (s.span === "work") {
		t0 = comp.workAreaStart;
		t1 = comp.workAreaStart + comp.workAreaDuration;
	} else if (s.span === "custom") {
		t0 = s.tStart;
		t1 = s.tEnd;
	} else {
		t0 = layer.inPoint;
		t1 = layer.outPoint;
	}
	if (t1 <= t0) t1 = t0 + 1 / fps;
	return [t0, t1];
}

function presetName(p) {
	return (
		[
			"Opacity",
			"Recolor",
			"Cycle",
			"Mosaic",
			"Posterize",
			"Glow",
			"Threshold",
			"Fadi Lights",
			"Fadi Darks",
		][p] || "FX"
	);
}

function applyToLayer(comp, layer, s, fps) {
	var span = timeSpan(comp, layer, s, fps);
	var t0 = span[0],
		t1 = span[1];

	// Opacity preset = whole-layer transform-opacity strobe (the fadiStrobe behavior)
	if (s.preset === 0) {
		var op0 = layer.property("ADBE Transform Group").property("ADBE Opacity");
		clearKeys(op0);
		if (s.modulation !== "static") {
			strobeProp(
				op0,
				0,
				100,
				s.modulation,
				s.onFrames,
				s.offFrames,
				t0,
				t1,
				fps,
			);
		}
		return;
	}

	// Other presets: build a keyed duplicate above the untouched original
	var dup = layer.duplicate();
	dup.name = "fadiRange — " + presetName(s.preset);

	if (s.mode === 1) addExtract(dup, s);
	else if (s.mode === 2) addColorKey(dup, s);

	var hueProp = null; // Colorize hue prop (Recolor/Cycle) for hue cycling
	var colorProp = null; // Tint color prop (duotones) for color cycling
	if (s.preset === 1) addColorize(dup, s.fadi[0]);
	else if (s.preset === 2) hueProp = addColorize(dup, s.fadi[0]);
	else if (s.preset === 3) addMosaic(dup, s, comp);
	else if (s.preset === 4) addPosterize(dup, s);
	else if (s.preset === 5) addGlow(dup);
	else if (s.preset === 6) addThreshold(dup, s);
	else if (s.preset === 7) colorProp = addDuotone(dup, s, "lights");
	else if (s.preset === 8) colorProp = addDuotone(dup, s, "darks");

	var op = dup.property("ADBE Transform Group").property("ADBE Opacity");
	if (s.modulation === "cycle" && hueProp) {
		cycleHue(hueProp, fadiHues(s.fadi), s.onFrames, t0, t1, fps);
	} else if (s.modulation === "cycle" && colorProp) {
		cycleColor(colorProp, fadiRGBs(s.fadi), s.onFrames, t0, t1, fps);
	} else if (s.modulation !== "static") {
		clearKeys(op);
		strobeProp(op, 0, 100, s.modulation, s.onFrames, s.offFrames, t0, t1, fps);
	}
}

// ---------- Range keyers ----------
function addExtract(layer, s) {
	var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Extract");
	fx.name = "fadiRange Luma";
	try {
		fx.property("Black Point").setValue(Math.round(s.lumaLo * 255));
	} catch (e) {}
	try {
		fx.property("White Point").setValue(Math.round(s.lumaHi * 255));
	} catch (e) {}
	var soft = Math.round(s.feather * 255);
	try {
		fx.property("Black Softness").setValue(soft);
	} catch (e) {}
	try {
		fx.property("White Softness").setValue(soft);
	} catch (e) {}
}

function addColorKey(layer, s) {
	var fx = layer
		.property("ADBE Effect Parade")
		.addProperty("ADBE Linear Color Key2");
	fx.name = "fadiRange Color";
	try {
		fx.property("Key Color").setValue([s.target[0], s.target[1], s.target[2]]);
	} catch (e) {}
	try {
		fx.property("Matching Tolerance").setValue(Math.round(s.tolerance * 100));
	} catch (e) {}
	try {
		fx.property("Matching Softness").setValue(Math.round(s.feather * 100));
	} catch (e) {}
	try {
		fx.property("Key Operation").setValue(2);
	} catch (e) {} // 2 = Keep Colors
}

// ---------- Effect presets ----------
function addColorize(layer, hex) {
	var fx = layer
		.property("ADBE Effect Parade")
		.addProperty("ADBE HUE SATURATION");
	fx.name = "fadiRange Colorize";
	try {
		fx.property("Colorize").setValue(1);
	} catch (e) {}
	var hsl = hexToHSL(hex);
	try {
		fx.property("Colorize Hue").setValue(hsl[0]);
	} catch (e) {}
	try {
		fx.property("Colorize Saturation").setValue(Math.round(hsl[1] * 100));
	} catch (e) {}
	return fx.property("Colorize Hue");
}

function addMosaic(layer, s, comp) {
	var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Mosaic");
	fx.name = "fadiRange Mosaic";
	var hb = Math.max(1, s.mosaic);
	var vb = Math.max(1, Math.round((s.mosaic * comp.height) / comp.width));
	try {
		fx.property("Horizontal Blocks").setValue(hb);
	} catch (e) {}
	try {
		fx.property("Vertical Blocks").setValue(vb);
	} catch (e) {}
}

function addPosterize(layer, s) {
	var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Posterize");
	fx.name = "fadiRange Posterize";
	try {
		fx.property("Levels").setValue(Math.max(2, s.poster));
	} catch (e) {}
}

function addGlow(layer) {
	var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Glo2");
	fx.name = "fadiRange Glow";
}

function addThreshold(layer, s) {
	var parade = layer.property("ADBE Effect Parade");
	var fx;
	try {
		fx = parade.addProperty("ADBE Threshold");
	} catch (e) {
		fx = parade.addProperty("ADBE Threshold2");
	}
	fx.name = "fadiRange Threshold";
	var lvl = Math.round((s.threshold != null ? s.threshold : 0.5) * 255);
	try {
		fx.property("Level").setValue(lvl);
	} catch (e) {}
	return fx;
}

// Threshold to pure B&W, then Tint maps the two tones.
// which="lights" -> lights=duoColor, darks=black (returns Map White To)
// which="darks"  -> lights=white,    darks=duoColor (returns Map Black To)
function addDuotone(layer, s, which) {
	addThreshold(layer, s);
	var tint = layer.property("ADBE Effect Parade").addProperty("ADBE Tint");
	tint.name = "fadiRange Duotone";
	var duo = [s.duoColor[0], s.duoColor[1], s.duoColor[2]];
	try {
		tint.property("Amount to Tint").setValue(100);
	} catch (e) {}
	if (which === "lights") {
		try {
			tint.property("Map Black To").setValue([0, 0, 0]);
		} catch (e) {}
		try {
			tint.property("Map White To").setValue(duo);
		} catch (e) {}
		return tint.property("Map White To");
	} else {
		try {
			tint.property("Map Black To").setValue(duo);
		} catch (e) {}
		try {
			tint.property("Map White To").setValue([1, 1, 1]);
		} catch (e) {}
		return tint.property("Map Black To");
	}
}

// ---------- Modulation keyframing ----------
function strobeProp(prop, lo, hi, mod, onF, offF, t0, t1, fps) {
	var period = Math.max(1, onF + offF);
	var totalFrames = Math.round((t1 - t0) * fps);
	var frame = 0;

	if (mod === "pulse") {
		while (frame < totalFrames) {
			for (var w = 0; w < period && frame + w < totalFrames; w++) {
				var pos = w / period;
				var v = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(pos * Math.PI * 2));
				prop.setValueAtTime(t0 + (frame + w) / fps, v);
			}
			frame += period;
		}
		return; // smooth — leave linear interpolation
	}

	while (frame < totalFrames) {
		var onVal, offVal;
		if (mod === "flicker") {
			onVal = lo + Math.random() * (hi - lo);
			offVal = lo + Math.random() * (hi - lo);
		} else {
			onVal = hi;
			offVal = lo;
		}
		prop.setValueAtTime(t0 + frame / fps, onVal);
		if (offF > 0) prop.setValueAtTime(t0 + (frame + onF) / fps, offVal);
		frame += period;
	}
	holdAll(prop);
}

function cycleHue(prop, hues, hold, t0, t1, fps) {
	var totalFrames = Math.round((t1 - t0) * fps);
	var frame = 0,
		idx = 0;
	var step = Math.max(1, hold);
	while (frame < totalFrames) {
		prop.setValueAtTime(t0 + frame / fps, hues[idx % hues.length]);
		frame += step;
		idx++;
	}
	holdAll(prop);
}

// Step a color property through the fadi palette (duotone cycle)
function cycleColor(prop, colors, hold, t0, t1, fps) {
	var totalFrames = Math.round((t1 - t0) * fps);
	var frame = 0,
		idx = 0;
	var step = Math.max(1, hold);
	while (frame < totalFrames) {
		prop.setValueAtTime(t0 + frame / fps, colors[idx % colors.length]);
		frame += step;
		idx++;
	}
	holdAll(prop);
}

// ---------- Helpers ----------
function clearKeys(prop) {
	while (prop.numKeys > 0) prop.removeKey(1);
}

function holdAll(prop) {
	for (var k = 1; k <= prop.numKeys; k++) {
		prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD);
	}
}

function fadiHues(fadi) {
	var out = [];
	for (var i = 0; i < fadi.length; i++) out.push(hexToHSL(fadi[i])[0]);
	return out;
}

function fadiRGBs(fadi) {
	var out = [];
	for (var i = 0; i < fadi.length; i++) {
		var h = fadi[i].replace("#", "");
		out.push([
			parseInt(h.substring(0, 2), 16) / 255,
			parseInt(h.substring(2, 4), 16) / 255,
			parseInt(h.substring(4, 6), 16) / 255,
		]);
	}
	return out;
}

function hexToHSL(hex) {
	hex = hex.replace("#", "");
	var r = parseInt(hex.substring(0, 2), 16) / 255;
	var g = parseInt(hex.substring(2, 4), 16) / 255;
	var b = parseInt(hex.substring(4, 6), 16) / 255;
	var mx = Math.max(r, g, b),
		mn = Math.min(r, g, b);
	var h = 0,
		s = 0,
		l = (mx + mn) / 2,
		d = mx - mn;
	if (d > 0.00001) {
		s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
		if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
		else if (mx === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
	}
	return [h * 360, s, l];
}
