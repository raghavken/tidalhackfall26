`timescale 1ns/1ps
// FAST=1 injects UART-decoded bytes; FAST=0 exercises serial input as well.
module tb_integration;
parameter FAST=1;
reg clk=0,reset_n=0,rx=1,inject_valid=0;
reg [7:0] inject_data=0;
always #5 clk=~clk;
wire tx; wire [5:0] red; wire [7:0] green;
reg [7:0] bytes[0:58799]; reg [73:0] expected[0:11];
reg [1023:0] input_file,expected_file,output_file;
wire [7:0] out_data; wire out_valid,out_error;
reg [111:0] packet=0;
reg [7:0] checksum=0;
integer i,j,k,received=0,position=0,n_bytes,n_results,fd;
top #(.CLOCK_HZ(1600000),.BAUD(100000)) dut(clk,reset_n,1'b0,rx,tx,red,green);
uart_rx #(.CLOCK_HZ(1600000),.BAUD(100000)) monitor(clk,reset_n,tx,out_data,out_valid,out_error);
generate if(FAST) begin
 initial begin force dut.rx_data=inject_data; force dut.rx_valid=inject_valid; end
end endgenerate
always @(posedge clk) begin
 if(out_error) $fatal(1,"FAIL integration output framing");
 if(out_valid) begin
  $fwrite(fd,"%02x\n",out_data);
  packet[position*8 +: 8]=out_data;
  if(position==13) begin
   if(received>=n_results || packet[7:0]!==8'h55 || checksum!==out_data ||
      packet[15:8]>3 || packet[95:87]!==9'd0 || packet[103:97]!==7'd0 ||
      {packet[9:8],packet[31:16],packet[86:32],packet[96]}!==expected[received])
       $fatal(1,"FAIL integration result %d packet %h expected %h",received,packet,expected[received]);
   received=received+1; position=0; checksum=0;
  end else begin position=position+1; checksum=checksum+out_data; end
 end
end
initial begin
 if(!$value$plusargs("INPUT=%s",input_file) || !$value$plusargs("EXPECTED=%s",expected_file) ||
    !$value$plusargs("OUTPUT=%s",output_file) || !$value$plusargs("BYTES=%d",n_bytes) ||
    !$value$plusargs("RESULTS=%d",n_results)) $fatal(1,"FAIL integration args");
 $readmemh(input_file,bytes,0,n_bytes-1); $readmemh(expected_file,expected,0,n_results-1);
 fd=$fopen(output_file,"w"); if(!fd) $fatal(1,"FAIL output file");
 repeat(5) @(negedge clk); reset_n=1; repeat(16) @(negedge clk);
 for(i=0;i<n_bytes;i=i+1) begin
  if(FAST) begin
   inject_data=bytes[i]; inject_valid=1; @(negedge clk); inject_valid=0; @(negedge clk);
  end else begin
   rx=0; repeat(16) @(negedge clk);
   for(j=0;j<8;j=j+1) begin rx=bytes[i][j]; repeat(16) @(negedge clk); end
   rx=1; repeat(16) @(negedge clk);
  end
 end
 repeat(20000) @(negedge clk);
 if(received!=n_results || position || red[4] || !red[5]) $fatal(1,"FAIL integration result count/state %d %h",received,red);
 $fclose(fd);
 $display("PASS integration FAST=%0d, %0d input bytes, %0d exact result packets",FAST,n_bytes,received); $finish;
end
initial begin #40000000; $fatal(1,"FAIL integration timeout"); end
endmodule
