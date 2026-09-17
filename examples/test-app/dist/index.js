/**
 * Test Application for devharness Debugger
 * This application contains intentional bugs for debugging challenges
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3101;
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.get('/api/user/:id', (req, res) => {
    const userId = parseInt(req.params.id);
    console.log(`Fetching user ${userId}`);
    if (userId > 0) {
        // BUG: Always returns 500 even for valid IDs
        res.status(500).json({
            id: userId,
            name: `User ${userId}`,
            email: `user${userId}@example.com`
        });
    }
    else {
        res.status(400).json({ error: 'Invalid user ID' });
    }
});
// Challenge 2: Console Error Tracking
// Multiple console errors scattered throughout
app.post('/api/data', (req, res) => {
    const { items } = req.body;
    if (!items) {
        console.error('ERROR: Missing items in request body');
        return res.status(400).json({ error: 'Items required' });
    }
    if (!Array.isArray(items)) {
        console.error('ERROR: Items must be an array');
        return res.status(400).json({ error: 'Items must be array' });
    }
    // Challenge 3: Variable Inspection Bug (Off-by-one error)
    const processed = processItems(items);
    res.json({ processed });
});
// BUG: Off-by-one error that causes undefined access
function processItems(items) {
    const result = [];
    console.log('Processing items...', items);
    // BUG: i <= items.length should be i < items.length
    for (let i = 0; i <= items.length; i++) {
        const item = items[i];
        if (item) {
            result.push(item.toUpperCase());
        }
        else {
            console.warn('WARN: Undefined item at index', i);
        }
    }
    return result;
}
// Challenge 4: Async Race Condition
app.get('/api/async-data', async (req, res) => {
    try {
        const data = await fetchDataWithDelay();
        res.json(data);
    }
    catch (error) {
        console.error('ERROR: Failed to fetch async data', error);
        res.status(500).json({ error: 'Server error' });
    }
});
// BUG: Race condition - doesn't properly handle concurrent requests
let sharedCounter = 0;
async function fetchDataWithDelay() {
    // Simulate async operation
    sharedCounter++;
    const localCounter = sharedCounter;
    await new Promise(resolve => setTimeout(resolve, 100));
    // BUG: sharedCounter might have changed
    console.log(`Fetched data for request ${localCounter}, but counter is now ${sharedCounter}`);
    return {
        requestId: localCounter,
        currentCounter: sharedCounter,
        timestamp: Date.now()
    };
}
// Challenge 4: Pricing API - returns valid config that gets corrupted client-side
app.get('/api/pricing', (req, res) => {
    // Server returns CORRECT values - the bug is in client-side processing
    res.json({
        basePrice: 100,
        discountPercent: 20, // 20% discount
        taxRate: 10 // 10% tax
    });
});
// Challenge 8: Performance Issue (Slow endpoint)
app.get('/api/slow', async (req, res) => {
    console.log('Starting slow operation...');
    // Simulate slow operation
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('Slow operation completed');
    res.json({ message: 'This was slow!' });
});
// Challenge 7: Secret Vault Password (Logpoints Required)
// Server validates the password constructed client-side
app.post('/api/vault', (req, res) => {
    const { userId, accessLevel, password } = req.body;
    if (!userId || accessLevel === undefined || !password) {
        return res.status(400).json({ error: 'userId, accessLevel, and password required' });
    }
    console.log(`Validating vault unlock for user ${userId} with access level ${accessLevel}`);
    // Construct the expected password server-side to validate
    const expectedPassword = unlockVault(userId, accessLevel);
    if (password === expectedPassword) {
        res.json({
            success: true,
            message: 'Vault unlocked successfully!',
            password: password,
            hint: 'The password was constructed piece by piece on the client. Use logpoints in constructVaultPassword() to observe how it was built character by character!'
        });
    }
    else {
        res.json({
            success: false,
            message: 'Incorrect password! The vault remains locked.',
            hint: 'Use logpoints to debug the password construction in the client code.'
        });
    }
});
// Constructs vault password from security tokens
// LOGPOINT CHALLENGE: Set logpoints to observe password construction
function constructVaultPassword() {
    const securityTokens = ['Secret', 'Passphrase', 'Alpha', 'Bravo', 'Charlie', 'Delta'];
    let password = '';
    console.log('Starting password construction...');
    // Password built character by character
    for (let i = 0; i < securityTokens.length; i++) {
        const token = securityTokens[i];
        const char = token.charAt(0); // LOGPOINT HERE: Log 'char' or 'password' to see construction
        password += char;
        // Intentionally not logging the complete password
        console.log(`Processing token ${i + 1}/${securityTokens.length}...`);
    }
    return password; // Returns "SPAbCD" but never logged completely
}
// Adds access level modifier to password
function getAccessModifier(level) {
    let modifier = '';
    // LOGPOINT HERE: Log 'modifier' with condition 'level > 2'
    if (level >= 1) {
        modifier += '_L';
    }
    if (level >= 2) {
        modifier += String(level);
    }
    if (level >= 5) {
        modifier += '_ADMIN';
    }
    return modifier;
}
// Main vault unlock function
function unlockVault(userId, accessLevel) {
    console.log(`User ${userId} attempting to unlock vault with level ${accessLevel}`);
    const basePassword = constructVaultPassword();
    const modifier = getAccessModifier(accessLevel);
    // LOGPOINT HERE: Log 'basePassword' and 'modifier' separately
    const finalPassword = basePassword + modifier;
    // Never log the final password completely
    console.log('Vault password generated successfully');
    return finalPassword;
}
// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});
// Start server
app.listen(PORT, () => {
    console.log(`Test app running on http://localhost:${PORT}`);
    console.log('Ready for debugging challenges!');
});
export { processItems, fetchDataWithDelay, unlockVault, constructVaultPassword, getAccessModifier };
//# sourceMappingURL=index.js.map