import mongoose from 'mongoose';

async function approveAll() {
    await mongoose.connect('mongodb://localhost:27017/win_win_game');
    
    const result = await mongoose.connection.collection('users').updateMany(
        { "withdrawals.status": "Pending" },
        { $set: { "withdrawals.$[elem].status": "Approved" } },
        { arrayFilters: [ { "elem.status": "Pending" } ] }
    );

    console.log(`Successfully approved ${result.modifiedCount} withdrawal requests.`);
    await mongoose.disconnect();
}

approveAll().catch(console.error);