import * as chai from 'chai'
import * as chaiAsPromised from 'chai-as-promised'
import 'mocha'
import { Pool, PoolConfig } from 'pg'
import PgTransaction from '../src/PgTransaction'

chai.use(chaiAsPromised)
let expect = chai.expect

let poolHolder: { pool: Pool } = {} as any

describe('PgTransaction', function() {
  beforeEach(async function() {
    poolHolder.pool = new Pool(<PoolConfig> {
      host: 'db',
      database: 'transaction_test',
      user: 'transaction_test',
      password: 'transaction_test'
    })

    await poolHolder.pool.query('CREATE TABLE IF NOT EXISTS a ( b INTEGER )')
  })

  afterEach(async function() {
    await poolHolder.pool.query('DROP TABLE IF EXISTS a CASCADE')
    await poolHolder.pool.end(() => {})
  })

  describe('connect', function() {
    it('should connect', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      
      await tx.connect()

      expect(tx.client).to.be.not.undefined
      expect(poolHolder.pool.idleCount).to.equal(0)
    })

    it('should not connect a second time', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      
      await tx.connect()
      await tx.connect()

      expect(tx.client).to.be.not.undefined
      expect(poolHolder.pool.idleCount).to.equal(0)
    })
  })

  describe('release', function() {
    it('should release', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      
      await tx.connect()
      expect(tx.client).to.be.not.undefined
      expect(poolHolder.pool.idleCount).to.equal(0)

      tx.release()
      expect(tx.client).to.be.undefined
      expect(poolHolder.pool.idleCount).to.equal(1)
    })

    it('should not release when inside a transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      
      await tx.connect()
      await tx.begin()

      expect(function() { tx.release() }).to.throw('Transaction is running. Cannot release.')
    })
  })

  describe('begin', function() {
    it('should beginn a transaction and connect automatically', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      expect(tx.client).to.be.not.undefined
      expect(tx.beginCounter).to.equal(1)
    })

    it('should increase the begin counter when beginning another transaction where one was alread started', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.begin()
      expect(tx.client).to.be.not.undefined
      expect(tx.beginCounter).to.equal(2)

      await tx.begin()
      expect(tx.client).to.be.not.undefined
      expect(tx.beginCounter).to.equal(3)
    })
  })

  describe('commit', function() {
    it('should commit a transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.query('INSERT INTO a VALUES (1)')
      await tx.commit()

      expect(tx.client).to.be.undefined
      expect(tx.beginCounter).to.equal(0)

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(1)
      expect(result.rows[0].b).to.equal(1)
    })

    it('should not commit a transaction if there was more than one begin', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.begin()
      await tx.query('INSERT INTO a VALUES (1)')
      await tx.commit()
      
      expect(tx.client).to.be.not.undefined
      expect(tx.beginCounter).to.equal(1)

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(0)

      // clean up
      await tx.commit()
    })

    it('should commit a transaction if there was more than one begin', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.begin()
      await tx.query('INSERT INTO a VALUES (1)')
      await tx.commit()
      await tx.commit()

      expect(tx.client).to.be.undefined
      expect(tx.beginCounter).to.equal(0)

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(1)
      expect(result.rows[0].b).to.equal(1)
    })

    it('should throw an error if the transaction was not started', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      expect(tx.commit()).to.be.rejectedWith('Transaction not running. Cannot commit.')
    })

    it('should throw an error if there was a commit too much', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.commit()

      expect(tx.commit()).to.be.rejectedWith('Transaction not running. Cannot commit.')
    })
  })

  describe('rollback', function() {
    it('should rollback', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.query('INSERT INTO a VALUES (1)')
      await tx.rollback()

      expect(tx.client).to.be.undefined
      expect(tx.beginCounter).to.equal(0)

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(0)
    })

    it('should rollback if there was more than one begin', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.begin()
      await tx.query('INSERT INTO a VALUES (1)')
      await tx.rollback()

      expect(tx.client).to.be.undefined
      expect(tx.beginCounter).to.equal(0)

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(0)
    })

    it('should throw an error if the transaction was not started', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      expect(tx.rollback()).to.be.rejectedWith('Transaction not running. Cannot rollback.')
    })

    it('should throw an error if there was a rollback too much', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.rollback()

      expect(tx.rollback()).to.be.rejectedWith('Transaction not running. Cannot rollback.')
    })
  })

  describe('runInTransaction', function() {
    it('should wrap the code in a transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)
      
      await tx.runInTransaction(async () => {
        expect(tx.beginCounter).to.equal(1)
      })

      expect(tx.beginCounter).to.equal(0)
    })

    it('should commit as many times as it begun', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.begin()

      await tx.runInTransaction(async () => {
        await tx.begin()
        await tx.begin()
      })

      expect(tx.beginCounter).to.equal(2)
    })

    it('should rollback if there was an error', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      try {
        await tx.runInTransaction(async () => {
          await tx.query('INSERT INTO a VALUES (1)')
          throw new Error()
        })
      }
      catch (e) {}

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(0)
    })

    it('should release the client if there was an error', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      try {
        await tx.runInTransaction(async () => {
          await tx.query('INSERT INTO a VALUES (1)')
          throw new Error()
        })
      }
      catch (e) {}

      expect(tx.client).to.be.undefined
      expect(tx.beginCounter).to.equal(0)
    })

    it('should not rollback if there was a commit without a transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.runInTransaction(async () => {
        await tx.commit()
        expect(tx.commit()).to.be.rejectedWith('Transaction not running. Cannot commit.')
      })
    })

    it('should not rollback if there was a rollback without a transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.runInTransaction(async () => {
        await tx.commit()
        expect(tx.rollback()).to.be.rejectedWith('Transaction not running. Cannot rollback.')
      })
    })
  })

  describe('query', function() {
    it('should query inside a transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.begin()
      await tx.query('INSERT INTO a VALUES (1)')
      await tx.commit()

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(1)
      expect(result.rows[0].b).to.equal(1)
    })

    it('should query without a started transaction', async function() {
      let tx = new PgTransaction(poolHolder.pool)

      await tx.query('INSERT INTO a VALUES (1)')

      let result = await poolHolder.pool.query('SELECT * FROM a')
      expect(result.rows.length).to.equal(1)
      expect(result.rows[0].b).to.equal(1)
    })
  })
})