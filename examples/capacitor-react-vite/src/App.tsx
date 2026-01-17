import { useEffect, useState } from 'react';
import './App.css';
import { db, getAllDocuments, storeDocument } from './db';

function App() {
  const [docs, setDocs] = useState<any[]>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const init = async () => {
      const res = await db.allDocs({ include_docs: true, attachments: true, binary: true });
      setDocs(res.rows.map((item) => item.doc));
    };
    init();
  }, []);

  const storeMessage = async () => {
    if (message.trim() === '') return;
    const newDoc = {
      _id: new Date().toISOString(),
      message,
    };
    await storeDocument(newDoc);
    const updatedDocs = await getAllDocuments();
    setDocs(updatedDocs);
    setMessage('');
  };

  return (
    <div className="App">
      <h1>PouchDB capacitor SQLite Test</h1>

        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enter a message"
        />
        <button
          type="button"
          onClick={storeMessage}
          >Save</button>


      <h2>Stored Messages:</h2>
      <ul>
        {docs.map((doc) => (
          <li key={doc._id}>{doc.message}</li>
        ))}
      </ul>
      </div>

  );
}

export default App;
