const overlayColormapPresets = [
  {
    id: 'overlay-grayscale',
    label: 'Grayscale',
    colormapName: 'Grayscale',
    defaultOpacity: 0.6,
  },
  {
    id: 'overlay-hsv',
    label: 'HSV',
    colormapName: 'hsv',
    defaultOpacity: 0.8,
  },
  {
    id: 'overlay-hot-iron',
    label: 'Hot Iron',
    colormapName: 'hot_iron',
    defaultOpacity: 0.6,
  },
];

export default {
  'cornerstone.modalityOverlayDefaultColorMaps': {
    defaultSettings: {
      PT: {
        colormap: 'hsv',
        // Note: Right now, there is a nonlinear relationship between the opacity value
        // below and how it will get applied to the image. The limitation is in rendering.
        // We are working on this and will remove this note when it's fixed.
        // But don't expect 0.5 to be 50% opacity, but rather close to that.
        opacity: 0.5,
      },
      RTDOSE: {
        colormap: 'Isodose',
        // Note: Right now, there is a nonlinear relationship between the opacity value
        // below and how it will get applied to the image. The limitation is in rendering.
        // We are working on this and will remove this note when it's fixed.
        // But don't expect 0.5 to be 50% opacity, but rather close to that.
        opacity: 0.5,
      },
    },
    // Shared colormap presets that the UI can offer regardless of modality
    presets: overlayColormapPresets,
  },
};
