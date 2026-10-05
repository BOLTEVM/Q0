// The storage slots ERC-1967 reserves for a proxy's implementation, beacon and admin. Defined once, with no
// dependencies, so the start-up check, the deploy flows and the integrity checker all read the same slots.
// tests/upgradeIntegrity.test.ts re-derives each one (keccak256 of the name, minus 1): a wrong slot reads as
// "empty" and would make every proxy look uninitialised or every pool look unowned.

/** keccak256("eip1967.proxy.implementation") - 1 */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** keccak256("eip1967.proxy.beacon") - 1 */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
/** keccak256("eip1967.proxy.admin") - 1 (unused by UUPS proxies; must be empty) */
export const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
