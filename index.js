import express from 'express';
import PocketBase from 'pocketbase';
import { nanoid } from 'nanoid';
import { config } from 'dotenv'
config()
const app = express();
app.use(express.json());

// Initialize PocketBase client (make sure your PocketBase server is running)
// Also, authenticate as admin so we can update records if needed.
const pb = new PocketBase('http://127.0.0.1:8090');
const adminAuth = await pb.admins.authWithPassword('akshayforrivers@gmail.com', process.env.password);

// Default time limit: 1 hour in milliseconds
let DEFAULT_TIME_LIMIT = 3600000;

/**
 * POST /shorten
 * Expects a JSON body with:
 *   - link: The original URL to shorten.
 * 
 * Logic:
 *   - If a record for the URL exists:
 *       - If its "created" time is older than 1 hour, update it with a new short code.
 *       - Otherwise, create a new record.
 *   - If no record exists, create a new one.
 */
app.post("/shorten", async (req, res) => {
    // to create a dynamic time expiry window
    try {
        const { link, expiry } = req.body;
        if (!link) {
            return res.status(400).json({ error: 'Link is required.' });
        }


        const now = new Date();
        if (expiry) {
            DEFAULT_TIME_LIMIT = expiry - now;
        }
        // Check if a record already exists for the provided link.
        const filter = `originalUrl="${link}"`;
        const existingRecords = await pb.collection('urls').getFullList({ filter });

        if (existingRecords.length > 0) {
            const record = existingRecords[0];
            const createdTime = new Date(record.created);
            const timeDiff = now - createdTime;

            if (timeDiff > DEFAULT_TIME_LIMIT) {
                // Record is older than 1 hour, update it with a new short code.
                const newShortCode = nanoid(6);
                await pb.collection('urls').update(record.id, { shortCode: newShortCode });
                return res.json({
                    shortCode: newShortCode,
                    message: 'Existing URL was older than 1 hour; updated with new short code.'
                });
            } else {
                // Record is still within the 1-hour limit; create a new record.
                const shortCode = nanoid(6);
                const data = { originalUrl: link, shortCode };
                const newRecord = await pb.collection('urls').create(data);
                return res.json({
                    shortCode: newRecord.shortCode,
                    message: 'Existing URL is within 1 hour; new URL record created.'
                });
            }
        } else {
            // No record exists, create a new one.
            const shortCode = nanoid(6);
            const data = { originalUrl: link, shortCode };
            const newRecord = await pb.collection('urls').create(data);
            return res.json({
                shortCode: newRecord.shortCode,
                message: 'New URL record created.'
            });
        }
    } catch (error) {
        console.error('Error in /shorten:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * GET /stats/active
 * Returns the active URLs (those created within the last hour), grouped by creation date,
 * along with the list of active records.
 */
app.get("/stats/active", async (req, res) => {
    try {
        const now = new Date();
        const records = await pb.collection('urls').getFullList();

        // Filter to keep only records created within the last hour.
        const activeRecords = records.filter(record => {
            const createdTime = new Date(record.created);
            return now - createdTime <= DEFAULT_TIME_LIMIT;
        });

        // Group active records by their creation date (formatted as YYYY-MM-DD).
        const groupByDate = {};
        activeRecords.forEach(record => {
            const date = new Date(record.created).toISOString().split('T')[0];
            groupByDate[date] = (groupByDate[date] || 0) + 1;
        });

        const groups = Object.keys(groupByDate).map(date => ({
            date,
            count: groupByDate[date]
        }));

        return res.json({ total: activeRecords.length, groups, activeRecords });
    } catch (error) {
        console.error('Error in /stats/active:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * GET /urls/recent
 * Returns the 5 most recently created short URLs.
 */
app.get("/urls/recent", async (req, res) => {
    try {
        const records = await pb.collection('urls').getFullList();
        // Sort records descending by creation date.
        records.sort((a, b) => new Date(b.created) - new Date(a.created));
        const recentRecords = records.slice(0, 5).map(record => ({
            shortCode: record.shortCode,
            originalUrl: record.originalUrl
        }));

        return res.json(recentRecords);
    } catch (error) {
        console.error('Error in /urls/recent:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /urls/batch
 * Expects a JSON body with:
 *   - links: An array of long URLs.
 * For each URL:
 *   - If a record exists and its creation time exceeds 1 hour, update it with a new short code.
 *   - Otherwise, create a new record.
 * This endpoint now iterates over the links array and performs each request normally.
 */
app.post("/urls/batch", async (req, res) => {
    try {
        const { links, expiry } = req.body;
        if (!links || !Array.isArray(links)) {
            return res.status(400).json({ error: 'Links must be provided as an array.' });
        }


        // Build a filter string to get existing records for all provided links.
        const filter = links.map(link => `originalUrl="${link}"`).join(' || ');
        let existingRecords = [];
        if (links.length > 0) {
            existingRecords = await pb.collection('urls').getFullList({ filter });
        }

        // Create a map of originalUrl to the most recent record.
        const existingMap = {};
        existingRecords.forEach(record => {
            const url = record.originalUrl;
            if (!existingMap[url] || new Date(record.created) > new Date(existingMap[url].created)) {
                existingMap[url] = record;
            }
        });

        const results = [];
        const now = new Date();
        if (expiry) {
            DEFAULT_TIME_LIMIT = expiry - now;
        }
        for (const link of links) {
            if (existingMap[link]) {
                const record = existingMap[link];
                const createdTime = new Date(record.created);
                if (now - createdTime > DEFAULT_TIME_LIMIT) {
                    const newShortCode = nanoid(6);
                    await pb.collection('urls').update(record.id, { shortCode: newShortCode });
                    results.push({ link, shortCode: newShortCode, action: 'updated' });
                } else {
                    const shortCode = nanoid(6);
                    const data = { originalUrl: link, shortCode };
                    await pb.collection('urls').create(data);
                    results.push({ link, shortCode, action: 'created' });
                }
            } else {
                const shortCode = nanoid(6);
                const data = { originalUrl: link, shortCode };
                await pb.collection('urls').create(data);
                results.push({ link, shortCode, action: 'created' });
            }
        }

        return res.json(results);
    } catch (error) {
        console.error('Error in /urls/batch:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

// Start the Express server.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
