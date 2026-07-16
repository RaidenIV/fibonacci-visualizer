const PALETTES = Object.freeze({
  cmrmapReverse: [
    [0.00, "#ffffff"], [0.12, "#fff4aa"], [0.28, "#ff9a24"], [0.44, "#d72718"],
    [0.60, "#8b1f72"], [0.76, "#38336f"], [0.90, "#111d45"], [1.00, "#000000"],
  ],
  inferno: [[0,"#000004"],[0.18,"#320a5e"],[0.38,"#781c6d"],[0.58,"#bc3754"],[0.78,"#ed6925"],[1,"#fcffa4"]],
  plasma: [[0,"#0d0887"],[0.2,"#5b02a3"],[0.4,"#9a179b"],[0.6,"#cb4679"],[0.8,"#ed7953"],[1,"#f0f921"]],
  turbo: [[0,"#30123b"],[0.17,"#4661d6"],[0.34,"#36aaf9"],[0.5,"#1ae4b6"],[0.66,"#a4fc3c"],[0.83,"#f9ba38"],[1,"#7a0403"]],
  ice: [[0,"#02040f"],[0.25,"#063970"],[0.5,"#00a6c8"],[0.75,"#7ffcff"],[1,"#ffffff"]],
  acid: [[0,"#050505"],[0.2,"#2a0057"],[0.4,"#7d00ff"],[0.62,"#00ff8a"],[0.82,"#d7ff00"],[1,"#ffffff"]],
  mono: [[0,"#111111"],[0.35,"#5d5d5d"],[0.72,"#c7c7c7"],[1,"#ffffff"]],
});

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

export function createPaletteTexture(THREE, name = "cmrmapReverse") {
  const stops = PALETTES[name] || PALETTES.cmrmapReverse;
  const data = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    const position = index / 255;
    let left = stops[0];
    let right = stops.at(-1);
    for (let stopIndex = 0; stopIndex < stops.length - 1; stopIndex += 1) {
      if (position >= stops[stopIndex][0] && position <= stops[stopIndex + 1][0]) {
        left = stops[stopIndex];
        right = stops[stopIndex + 1];
        break;
      }
    }
    const span = Math.max(0.0001, right[0] - left[0]);
    const color = mix(hexToRgb(left[1]), hexToRgb(right[1]), (position - left[0]) / span);
    data[index * 4] = color[0];
    data[index * 4 + 1] = color[1];
    data[index * 4 + 2] = color[2];
    data[index * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
