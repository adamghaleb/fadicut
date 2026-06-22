/* fadiFX — ExtendScript: applies effects & keyframes to After Effects layers */
/* Note: ExtendScript is ES3 — no JSON.parse, no modern JS features */

function fadiFX_apply(settingsJSON) {
	try {
		// ExtendScript has no JSON.parse — eval is the standard pattern.
		// Input is a controlled JSON string from our own panel code.
		var s = eval("(" + settingsJSON + ")");
		var comp = app.project.activeItem;

		if (!comp || !(comp instanceof CompItem)) {
			return "ERROR: No active composition";
		}

		var selectedLayers = comp.selectedLayers;
		if (selectedLayers.length === 0) {
			return "ERROR: No layers selected";
		}

		var colors = s.colors;
		var frameDur = s.frameDuration;
		var strobeOn = s.strobeOn === 1;
		var strobeGap = s.strobeGap;
		var dir = s.direction;
		var waveMode = s.waveformMode;
		var pulseSpd = s.pulseSpeed;
		var mode = s.applyMode;
		var matchLayer = s.matchLayer === 1;
		var totalSec = s.totalDuration;
		var fps = comp.frameRate;

		// Colors arrive pre-ordered from the panel (start color is index 0,
		// reverse is already reversed). Build sequence handles ping-pong.
		var baseSeq = buildSequence(colors, dir);

		app.beginUndoGroup("fadiFX Apply");

		if (mode === "solid") {
			removeFadiFXSolids(comp);
		}

		for (var li = 0; li < selectedLayers.length; li++) {
			var layer = selectedLayers[li];

			var totalFrames;
			if (matchLayer) {
				totalFrames = Math.round((layer.outPoint - layer.inPoint) * fps);
			} else {
				totalFrames = Math.round(totalSec * fps);
			}

			if (mode === "solid") {
				applySolidMode(
					comp,
					layer,
					baseSeq,
					frameDur,
					strobeOn,
					strobeGap,
					totalFrames,
					fps,
					waveMode,
					pulseSpd,
				);
			} else {
				// Remove previous fadiFX effects AND any matching effect type
				removeFadiFXEffects(layer, mode);
				applyEffectMode(
					layer,
					baseSeq,
					frameDur,
					strobeOn,
					strobeGap,
					totalFrames,
					fps,
					mode,
					waveMode,
					pulseSpd,
				);
			}
		}

		app.endUndoGroup();
		return "Applied to " + selectedLayers.length + " layer(s)";
	} catch (e) {
		return "ERROR: " + e.toString();
	}
}

// Remove existing fadiFX effects AND effects matching the target type
function removeFadiFXEffects(layer, mode) {
	var effects = layer.property("ADBE Effect Parade");
	if (!effects) return;

	var targetMatch;
	if (mode === "fill") targetMatch = "ADBE Fill";
	else if (mode === "tint") targetMatch = "ADBE Tint";
	else if (mode === "glow") targetMatch = "ADBE Glo2";

	for (var i = effects.numProperties; i >= 1; i--) {
		var fx = effects.property(i);
		// Remove by fadiFX name prefix OR by matching effect type
		if (fx.name.indexOf("fadiFX") === 0 || fx.matchName === targetMatch) {
			fx.remove();
		}
	}
}

function removeFadiFXSolids(comp) {
	for (var i = comp.numLayers; i >= 1; i--) {
		if (comp.layer(i).name.indexOf("fadiFX_") === 0) {
			comp.layer(i).remove();
		}
	}
}

// Build sequence — for "forward" just pass through, for "pingpong" bounce
function buildSequence(colors, dir) {
	var seq = [];
	var i;
	if (dir === "pingpong") {
		for (i = 0; i < colors.length; i++) seq.push(colors[i]);
		for (i = colors.length - 2; i > 0; i--) seq.push(colors[i]);
	} else {
		// "forward" — colors arrive pre-ordered (reverse is baked in by panel)
		for (i = 0; i < colors.length; i++) seq.push(colors[i]);
	}
	return seq;
}

function hexToRGB(hex) {
	hex = hex.replace("#", "");
	return [
		parseInt(hex.substring(0, 2), 16) / 255,
		parseInt(hex.substring(2, 4), 16) / 255,
		parseInt(hex.substring(4, 6), 16) / 255,
	];
}

function getWaveformValue(mode, position, speed) {
	if (mode === "off") return 100;
	var t = position * speed * Math.PI * 2;
	if (mode === "sine") return 50 + 50 * Math.sin(t);
	if (mode === "triangle")
		return 50 + 50 * (2 / Math.PI) * Math.asin(Math.sin(t));
	if (mode === "square") return Math.sin(t) >= 0 ? 100 : 0;
	return 100;
}

function getEffectOpacity(effect, mode) {
	if (mode === "fill") return effect.property("Opacity");
	if (mode === "tint") return effect.property("Tint Amount");
	if (mode === "glow") return effect.property("Glow Intensity");
	return null;
}

function getColorProp(effect, mode) {
	if (mode === "fill") return effect.property("Color");
	if (mode === "tint") return effect.property("Map White To");
	if (mode === "glow") return effect.property("Glow Color A");
	return null;
}

function applyEffectMode(
	layer,
	seq,
	frameDur,
	strobeOn,
	strobeGap,
	totalFrames,
	fps,
	mode,
	waveMode,
	pulseSpd,
) {
	var effect;
	if (mode === "fill") {
		effect = layer.property("ADBE Effect Parade").addProperty("ADBE Fill");
		effect.name = "fadiFX Fill";
	} else if (mode === "tint") {
		effect = layer.property("ADBE Effect Parade").addProperty("ADBE Tint");
		effect.name = "fadiFX Tint";
	} else if (mode === "glow") {
		effect = layer.property("ADBE Effect Parade").addProperty("ADBE Glo2");
		effect.name = "fadiFX Glow";
	}

	var colorProp = getColorProp(effect, mode);
	var frame = 0;
	var seqIndex = 0;
	var startTime = layer.inPoint;

	while (frame < totalFrames) {
		var rgb = hexToRGB(seq[seqIndex % seq.length]);
		var time = startTime + frame / fps;
		var holdTime = startTime + (frame + frameDur - 1) / fps;

		colorProp.setValueAtTime(time, rgb);
		colorProp.setValueAtTime(holdTime, rgb);

		// Waveform pulse on effect opacity
		if (waveMode !== "off") {
			var opProp = getEffectOpacity(effect, mode);
			if (opProp) {
				var steps = Math.max(2, frameDur);
				for (var wi = 0; wi < steps; wi++) {
					var pos = wi / (steps - 1);
					var val = getWaveformValue(waveMode, pos, pulseSpd);
					var wTime = startTime + (frame + wi) / fps;
					if (mode === "glow") {
						opProp.setValueAtTime(wTime, (val / 100) * 4);
					} else {
						opProp.setValueAtTime(wTime, val);
					}
				}
			}
		}

		frame += frameDur;

		// Strobe — drop effect opacity to 0 during gap
		if (strobeOn === true) {
			var opStrobe = getEffectOpacity(effect, mode);
			if (opStrobe) {
				var gapStart = startTime + frame / fps;
				var gapEnd = startTime + (frame + strobeGap - 1) / fps;
				var restoreTime = startTime + (frame + strobeGap) / fps;

				opStrobe.setValueAtTime(gapStart, 0);
				opStrobe.setValueAtTime(gapEnd, 0);

				if (mode === "glow") {
					opStrobe.setValueAtTime(restoreTime, 4);
				} else {
					opStrobe.setValueAtTime(restoreTime, 100);
				}
			}
			frame += strobeGap;
		}

		seqIndex++;
	}

	// Hold interpolation on color keyframes
	if (colorProp.numKeys > 0) {
		for (var k = 1; k <= colorProp.numKeys; k++) {
			colorProp.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD);
		}
	}

	// Hold interpolation on opacity keyframes
	if (waveMode !== "off" || strobeOn === true) {
		var opFinal = getEffectOpacity(effect, mode);
		if (opFinal && opFinal.numKeys > 0) {
			for (var k = 1; k <= opFinal.numKeys; k++) {
				opFinal.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD);
			}
		}
	}
}

function applySolidMode(
	comp,
	layer,
	seq,
	frameDur,
	strobeOn,
	strobeGap,
	totalFrames,
	fps,
	waveMode,
	pulseSpd,
) {
	var frame = 0;
	var seqIndex = 0;
	var startTime = layer.inPoint;

	while (frame < totalFrames) {
		var rgb = hexToRGB(seq[seqIndex % seq.length]);
		var solidStart = startTime + frame / fps;
		var solidEnd = startTime + (frame + frameDur) / fps;

		var solid = comp.layers.addSolid(
			[rgb[0] * 255, rgb[1] * 255, rgb[2] * 255],
			"fadiFX_" + seq[seqIndex % seq.length].replace("#", ""),
			comp.width,
			comp.height,
			comp.pixelAspect,
			solidEnd - solidStart,
		);

		solid.startTime = solidStart;
		solid.inPoint = solidStart;
		solid.outPoint = solidEnd;
		solid.moveBefore(layer);

		if (waveMode !== "off") {
			var opProp = solid
				.property("ADBE Transform Group")
				.property("ADBE Opacity");
			var steps = Math.max(2, frameDur);
			for (var wi = 0; wi < steps; wi++) {
				var pos = wi / (steps - 1);
				var val = getWaveformValue(waveMode, pos, pulseSpd);
				opProp.setValueAtTime(solidStart + wi / fps, val);
			}
		}

		frame += frameDur;

		if (strobeOn === true) {
			frame += strobeGap;
		}

		seqIndex++;
	}
}
