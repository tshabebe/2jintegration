const test = require("node:test");
const assert = require("node:assert/strict");

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongoServer;
let appModule;

test.before(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.MONGODB_DB_NAME = "2jintegration-test";
  process.env.APP_BASE_URL = "http://127.0.0.1:3001";

  appModule = require("../app");
  await appModule.connectDatabase();
});

test.after(async () => {
  if (appModule) {
    await appModule.stop();
  }

  if (mongoServer) {
    await mongoServer.stop();
  }
});

test("2J seamless wallet smoke flow", async () => {
  const agent = request(appModule.app);

  const createUserResponse = await agent
    .post("/api/dev/users/upsert")
    .send({
      op_id: "player-1001",
      nickname: "GiftBet Tester",
      availableAmount: 5000,
      cnt: "ET",
      lan: "en",
    })
    .expect(200);

  assert.equal(createUserResponse.body.ok, true);
  assert.equal(createUserResponse.body.user.op_id, "player-1001");
  assert.equal(createUserResponse.body.user.availableAmount, 5000);

  const balanceResponse = await agent
    .post("/balance/get")
    .send({ op_id: "player-1001" })
    .expect(200);

  assert.equal(balanceResponse.body.header.code, 0);
  assert.equal(balanceResponse.body.result.availableAmount, 5000);

  const transferResponse = await agent
    .post("/order/transfer")
    .send({
      op_id: "player-1001",
      action: "bet",
      order: {
        trans_no: "tx-1001",
        amount: -250,
      },
    })
    .expect(200);

  assert.equal(transferResponse.body.header.code, 0);
  assert.equal(transferResponse.body.result.availableAmount, 4750);

  const duplicateTransferResponse = await agent
    .post("/order/transfer")
    .send({
      op_id: "player-1001",
      action: "bet",
      order: {
        trans_no: "tx-1001",
        amount: -250,
      },
    })
    .expect(200);

  assert.equal(duplicateTransferResponse.body.header.code, 0);
  assert.equal(duplicateTransferResponse.body.result.availableAmount, 4750);

  const batchTransferResponse = await agent
    .post("/order/batch_transfer")
    .send({
      action: "settle",
      trans_no: "batch-1001",
      orders: [
        {
          op_id: "player-1001",
          trans_no: "tx-1002",
          amount: 100,
        },
        {
          op_id: "missing-player",
          trans_no: "tx-1003",
          amount: 50,
        },
      ],
    })
    .expect(200);

  assert.equal(batchTransferResponse.body.header.code, 0);
  assert.equal(batchTransferResponse.body.result.data[0].availableAmount, 4850);
  assert.equal(batchTransferResponse.body.result.data[1].code, 103);

  const profileResponse = await agent
    .post("/member/profile")
    .send({ op_id: "player-1001" })
    .expect(200);

  assert.equal(profileResponse.body.header.code, 0);
  assert.equal(profileResponse.body.result.nickname, "GiftBet Tester");

  const businessResponse = await agent
    .post("/order/business")
    .send({
      event: "round_closed",
      round_id: "round-1",
    })
    .expect(200);

  assert.equal(businessResponse.body.header.code, 0);

  const debugStateResponse = await agent.get("/api/dev/users").expect(200);
  assert.equal(debugStateResponse.body.users.length, 1);
  assert.equal(debugStateResponse.body.processedTransfers.length, 2);
  assert.equal(debugStateResponse.body.processedBatchTransfers.length, 1);
  assert.equal(debugStateResponse.body.businessEvents.length, 1);
});
