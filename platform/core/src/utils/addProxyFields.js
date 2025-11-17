/**
 * fieldProxies has the set of fields which are proxied on a per-field basis
 * to the child element.
 */
export const fieldProxies = [
  'ImagePositionPatient',
  'ImageOrientationPatient',
  'PixelSpacing',
  // more fields as necessary
];

const METADATA_PROXY_FLAG = Symbol('isMetadataProxy');

/**
 * Adds proxy properties for a limited number of values which are sometimes
 * defined in multiframe instance data.
 *
 * If a requested field is in `metadataFieldsToWrap`:
 *   - It first tries to return the value from the current instance.
 *   - If not found, it attempts to retrieve the value from the `_parentInstance`.
 *   - If still not found, it checks `_parentInstance._shared`.
 *   - If none exist, it returns `undefined`.
 *
 * For all other properties, it behaves like a regular property access.
 *
 * This allows graceful fallback access for DICOM metadata values that might be spread
 * across nested or shared metadata structures.
 *
 * @param {Object} instance - The target instance object to wrap.
 * @returns {Proxy} A proxy-wrapped instance with custom field resolution behavior.
 */
export function addProxyFields(instance) {
  // Skip wrapping if already wrapped
  if (!instance || instance[METADATA_PROXY_FLAG]) {
    return instance;
  }

  for (const fieldProxy of fieldProxies) {
    if (fieldProxy in instance) {
      continue;
    }
    // Use a private property name to store the actual value on the instance
    const valueKey = `_${fieldProxy}_local`;
    Object.defineProperty(instance, fieldProxy, {
      configurable: true,
      enumerable: true,
      get: () => {
        // First check if a value was explicitly set on this instance
        if (valueKey in instance) {
          return instance[valueKey];
        }
        // Otherwise fall back to parent or shared
        return (
          instance._parentInstance?.[fieldProxy] ?? instance._parentInstance?._shared?.[fieldProxy]
        );
      },
      set: value => {
        // Store the value directly on the instance
        instance[valueKey] = value;
      },
    });
  }

  // Mark this proxy to avoid double wrapping
  Object.defineProperty(instance, METADATA_PROXY_FLAG, { value: true });

  return instance;
}

export default addProxyFields;
