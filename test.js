const axios = require('axios');
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

const secretKey = '0dccfdca504420c1ccd06a8996dd6987d85276e0e7a247b88d4d0ae11d7b5c45'; // Replace with your key

readline.question('Enter Bank Code (e.g., 100004 for OPay): ', (bankCode) => {
  readline.question('Enter Account Number: ', async (accountNumber) => {
    try {
      const response = await axios.get(`https://api.lenco.co/access/v1/resolve`, {
        params: { accountNumber, bankCode },
        headers: { 'Authorization': `Bearer ${secretKey}`, 'accept': 'application/json' }
      });

      const data = response.data.data;
      const accountName = data?.accountName || data?.account_name;

      console.log('\n✅ Account Verified');
      console.log(`   Name   : ${accountName}`);
      console.log(`   Number : ${data?.accountNumber || accountNumber}`);
      console.log(`   Bank   : ${data?.bank?.name}`);

    } catch (error) {
      console.error('\n❌ Error:', error.response?.data?.message || error.message);
    }
    readline.close();
  });
});