/* fadiStrobe — ExtendScript: keyframes layer Opacity into strobe patterns */
/* Note: ExtendScript is ES3 — no JSON.parse, no modern JS features */

function fadiStrobe_apply(settingsJSON) {
	try {
		// ExtendScript has no JSON.parse — eval is the standard pattern.
		// Input is a controlled JSON string from our own panel code.
		var s = eval("(" + settingsJSON + ")");
		var comp = app.project.activeItem;

		if (!comp || !(comp instanceof CompItem)) {
			return "ERROR: No active composition";
		}

		var layers = comp.selectedLayers;
		if (layers.length === 0) {
			return "ERROR: No layers selected";
		}

		var style = s.style; // "hard" | "pulse" | "triangle" | "flicker"
		var onFrames = Math.max(1, s.onFrames);
		var offFrames = Math.max(0, s.offFrames);
		var maxOp = s.maxOpacity;
		var minOp = s.minOpacity;
		var stagger = Math.max(0, s.stagger);
		var matchLayer = s.matchLayer === 1;
		var totalSec = s.totalDuration;
		var fps = comp.frameRate;

		app.beginUndoGroup("fadiStrobe Apply");

		var applied = 0;
		for (var li = 0; li < layers.length; li++) {
			var layer = layers[li];
			var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
			if (!op) continue;

			// Clear any existing opacity keyframes so re-applying is clean
			while (op.numKeys > 0) op.removeKey(1);

			var layerFrames;
			if (matchLayer) {
				layerFrames = Math.round((layer.outPoint - layer.inPoint) * fps);
			} else {
				layerFrames = Math.round(totalSec * fps);
			}

			var delayFrames = li * stagger;
			var strobeFrames = layerFrames - delayFrames;
			if (strobeFrames < 1) continue;

			var startTime = layer.inPoint + delayFrames / fps;

			// If staggered, hold layer at max until its strobe begins
			if (delayFrames > 0) {
				op.setValueAtTime(layer.inPoint, maxOp);
			}

			if (style === "hard" || style === "flicker") {
				applyStepStrobe(
					op,
					style,
					onFrames,
					offFrames,
					minOp,
					maxOp,
					strobeFrames,
					fps,
					startTime,
				);
			} else {
				applyWaveStrobe(
					op,
					style,
					onFrames,
					offFrames,
					minOp,
					maxOp,
					strobeFrames,
					fps,
					startTime,
				);
			}

			applied++;
		}

		app.endUndoGroup();

		if (applied === 0)
			return "ERROR: Nothing applied (check stagger vs duration)";
		return "Strobed " + applied + " layer(s)";
	} catch (e) {
		return "ERROR: " + e.toString();
	}
}

// Hard / Flicker — discrete on/off (or random) levels, HOLD interpolation
function applyStepStrobe(
	op,
	style,
	onFrames,
	offFrames,
	minOp,
	maxOp,
	totalFrames,
	fps,
	startTime,
) {
	var period = onFrames + offFrames;
	if (period < 1) period = 1;

	var frame = 0;
	while (frame < totalFrames) {
		var onVal, offVal;
		if (style === "flicker") {
			onVal = minOp + Math.random() * (maxOp - minOp);
			offVal = minOp + Math.random() * (maxOp - minOp);
		} else {
			onVal = maxOp;
			offVal = minOp;
		}

		// ON segment
		op.setValueAtTime(startTime + frame / fps, onVal);

		// OFF segment (only if there's a gap)
		if (offFrames > 0) {
			op.setValueAtTime(startTime + (frame + onFrames) / fps, offVal);
		}

		frame += period;
	}

	// Hard edges — hold every key
	for (var k = 1; k <= op.numKeys; k++) {
		op.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD);
	}
}

// Pulse (sine) / Triangle — smooth oscillation, sampled per frame, linear interp
function applyWaveStrobe(
	op,
	style,
	onFrames,
	offFrames,
	minOp,
	maxOp,
	totalFrames,
	fps,
	startTime,
) {
	var period = onFrames + offFrames;
	if (period < 1) period = 1;

	var amp = maxOp - minOp;

	var frame = 0;
	while (frame <= totalFrames) {
		var pos = (frame % period) / period; // 0..1 within the cycle
		var v;
		if (style === "pulse") {
			v = minOp + amp * (0.5 - 0.5 * Math.cos(pos * Math.PI * 2));
		} else {
			// triangle
			v = minOp + amp * (1 - Math.abs(2 * pos - 1));
		}
		op.setValueAtTime(startTime + frame / fps, v);
		frame += 1;
	}
	// Leave default (linear) interpolation for smooth ramps.
}
