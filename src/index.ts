export const version = "1.0.0";

export type FieldType = "byte" | "boolean" | "float16" | "float32" | "string";

export interface PacketSchema {
  name: string;
  fields: Record<string, FieldType>;
  _sizeInBytes?: number;
  _stringFieldName?: string;
  _booleans?: number;
}

export type WispSchema = PacketSchema[];

export class PacketWisp {
  #schema: WispSchema = [];
  packetIds: any;
  stringEncoder;
  stringDecoder;

  constructor(){
    this.packetIds = {};
    this.stringEncoder = new TextEncoder();
    this.stringDecoder =  new TextDecoder();
  }

  // loads the schema
  setSchema(schema: WispSchema){
    this.#schema = schema;
    Object.entries(schema).forEach(([id, packetSchema]) => {
      let sizeInBytes = 0;
      let booleans = 0;
      let strings = 0;
      Object.entries(packetSchema.fields).forEach(([field, dataType]) => { //calculate size in bytes
        if(dataType == "byte"){
          sizeInBytes += 1;
        }
        else if (dataType == "boolean"){
          booleans += 1;
        }
        else if(dataType == "float16"){
          sizeInBytes += 2;
        }
        else if(dataType == "float32"){
          sizeInBytes += 4;
        }
        else if(dataType == "string"){
          strings += 1;
          packetSchema._stringFieldName = field;
        }
      });
      sizeInBytes += Math.ceil(booleans / 8) //one byte fits 8 booleans

      if(strings > 1){
        console.warn(`PacketEncoder: Schema with name '${packetSchema.name}' has multiple strings. Only one string per packet is allowed. Skipping...`);
        return;
      };

      packetSchema._sizeInBytes = sizeInBytes;
      packetSchema._booleans = booleans;
      this.packetIds[packetSchema.name] = id;
    });
  }

  getSchemaFromName(schemaName: string){
    return this.#schema.find(i => i.name == schemaName)
  }

  getPacketIdFromName(packetName: string){
    return this.packetIds[packetName];
  }

  getSchemaFromId(packetId: number){
    return this.#schema[packetId];
  }

  // Packet encode method, encodes the given arbitrary packet data based on a schema, the schema is chosen based  on the
  // 'schemaName' field of the method. The function then goes through all the fields of the schema,
  // looks for them in the packetData object and encodes them into the final byte buffe.
  // By nature, any data in the object that is not part of the schema will not be sent.
  // 
  // Returns a byte buffer that can be sent over the WebSocket connection to be decoded on the other end
  encode(schemaName: string, packetData: any): ArrayBuffer{

    let schema = this.getSchemaFromName(schemaName);
    if(schema == undefined){
      throw new Error(`PacketEncoder: Schema name '${schemaName}' does not match any valid and loaded schema.`);
    }


    // calculates string length (if applies)
    let stringUtfSize = 0;
    if(schema._stringFieldName !== undefined && packetData[schema._stringFieldName] !== undefined){
      let stringData = packetData[schema._stringFieldName];
      stringUtfSize = this.stringEncoder.encode(stringData).length; //UTF8 size in bytes (some characters are more than one byte)
    }

    // calculates packetsize and prepare new buffer
    let packetSize = (schema._sizeInBytes ?? 1) + stringUtfSize + 1; //1 additional byte for packetType header
    let buffer = new ArrayBuffer(packetSize);
    let dataView = new DataView(buffer);
    let currentByte = 0;

    // packet headers (packet ID)
    let packetId = this.getPacketIdFromName(schemaName);
    dataView.setUint8(currentByte, packetId);
    currentByte += 1;

    // goes through all fields
    let booleanFields: string[] = [];
    Object.entries(schema.fields).forEach(([field, dataType]) => {
      if(dataType == "byte"){
        let value = packetData[field];
        if(value !== undefined){ 
          dataView.setUint8(currentByte, value); 
        }
        currentByte += 1;
        return;
      }
      else if(dataType == "float32"){
        let value = packetData[field];
        if(value !== undefined){ 
          dataView.setFloat32(currentByte, value);
        }
        currentByte += 4;
        return;
      }
      else if(dataType == "boolean"){
        booleanFields.push(field);
      }
    });

    // setting booleans (flag grouping)
    if((schema._booleans ?? 0) > 0){
      let booleanGroups = Math.ceil((schema._booleans ?? 0) / 8);
      for(let i = 0; i < booleanGroups; i++){
        // works one byte (boolean group) at a time
        let groupByte = 0b00000000;
        for(let cb = 0; cb < Math.min(8, booleanFields.length); cb++){
          let index = cb + (i * 8);
          let fieldName = booleanFields[index]; //to avoid multiplying by 0
          if(fieldName === undefined){
            break;
          }
          groupByte = this.#setBit(groupByte, 7 - cb, packetData[fieldName] ?? false);
        }
        dataView.setUint8(currentByte, groupByte);
        currentByte += 1;
      }
    }
    
    // encode string
    if(schema._stringFieldName !== undefined && packetData[schema._stringFieldName] !== undefined){
      let stringData = packetData[schema._stringFieldName];
      let encodedString = this.stringEncoder.encode(stringData); //uInt8Array (TypedArray is not ArrayBuffer)

      // put the UTF8 bytes inside the buffer
      for(const byte of encodedString){
        if(currentByte >= packetSize){
          break;
        }
        dataView.setUint8(currentByte, byte);              // byte is number
        currentByte += 1;
      }
    }

    return buffer;
  }
  decode(inputData: ArrayBuffer): any{
    if(!this.#validateBuffer(inputData)){
      return; //silently fails (this method expects arbitrary packets from a client)
    }

    let packetData: any = {};
    let dataView = new DataView(inputData);
    let byteLength = dataView.byteLength;
    let schema = this.getSchemaFromId(dataView.getUint8(0));
    if(schema == undefined){
      return; //silently fails (this method expects arbitrary packets from a client)
    }
    let currentByte = 1;
    packetData.packetName = schema.name;

    // goes through all fields
    let booleanFields: string[] = [];
    Object.entries(schema.fields).forEach(([field, dataType]) => {
      if(dataType == "byte"){
        packetData[field] = dataView.getUint8(currentByte); 
        currentByte += 1;
        return;
      }
      else if(dataType == "float32"){
        packetData[field] = dataView.getFloat32(currentByte);
        currentByte += 4;
        return;
      }
      else if(dataType == "boolean"){
        booleanFields.push(field);
      }
    });

    // getting booleans (flag grouping)
    if((schema._booleans ?? 0) > 0){
      let booleanGroups = Math.ceil((schema._booleans ?? 1) / 8);
      for(let i = 0; i < booleanGroups; i++){
        // works one byte (boolean group) at a time
        let groupByte = dataView.getUint8(currentByte);
        // console.log({currentByte, groupByte});
        for(let cb = 0; cb < Math.min(8, booleanFields.length); cb++){
          let index = cb + (i * 8);
          if(index > booleanFields.length - 1){
            break;
          }
          let fieldName = booleanFields[index]; //to avoid multiplying by 0
          if(fieldName == undefined) continue;
          packetData[fieldName] = ((groupByte >> (7 - cb)) & 1) === 1;
        }
        currentByte += 1;
      }
    }

    // encode string
    if(schema._stringFieldName !== undefined && byteLength > (schema._sizeInBytes ?? 1) + 1){
      let stringBytes = new Uint8Array(inputData, currentByte, byteLength - currentByte);
      packetData[schema._stringFieldName] = this.stringDecoder.decode(stringBytes);
      currentByte = byteLength;
    }

    return packetData;
  }


  // Buffers arrive from untrusted clients, so every assumption decode() makes
  // about them is checked here before decode() reads a single field.
  #validateBuffer(data: ArrayBuffer){
    if(!this.#isArrayBuffer(data)){
      return false;
    }
    let dataView = new DataView(data);

    // need at least the packet id header
    if(dataView.byteLength < 1){
      return false;
    }

    let schema = this.getSchemaFromId(dataView.getUint8(0));
    if(schema == undefined){
      return false;
    }

    // the fixed-size fields must actually fit after the header, otherwise the
    // field reads below would run off the end of the buffer
    if(dataView.byteLength < (schema._sizeInBytes ?? 0) + 1){
      return false;
    }
    return true;
  }
  #setBit(byte: number, bitPosition: number, value: number) {
    if (value) {
        // Set the bit (use OR)
        return byte | (1 << bitPosition);
    } else {
        // Clear the bit (use AND with NOT)
        return byte & ~(1 << bitPosition);
    }
  }
  #isArrayBuffer(data: any){
    return data instanceof ArrayBuffer;
  }
}


